/**
 * ResultsApp - displays simulation outcomes.
 */

import { NarrativeGenerator } from "../engine/narrative-generator.js";

const MODULE_ID = "wfrp4e-combat-simulator";
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export class ResultsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ results, config, engine } = {}) {
    super();
    this.results = results;
    this.config = config;
    this.engine = engine;
    this.applied = false; // track so the user can't apply twice
    // Narrative is lazy-generated once per ResultsApp instance. The flavor
    // paragraph is cached after the first successful API call so re-renders
    // (e.g. after Apply) don't re-charge the API.
    this._narrativeGen = new NarrativeGenerator(results);
    this._narrativeBriefing = this._narrativeGen.extractBriefing();
    this._narrativeFlavor = null;     // string once generated
    this._narrativeFlavorError = null; // error code if API failed
    this._narrativeLoading = false;   // true during in-flight API call
  }

  static DEFAULT_OPTIONS = {
    id: "wfrp4e-combat-simulator-results",
    classes: ["wfrp4e", "wfrp4e-sim", "wfrp4e-sim-results"],
    tag: "div",
    window: {
      title: "WFRP4E_SIM.ResultsTitle",
      icon: "fas fa-scroll",
      resizable: true
    },
    position: {
      width: 900,
      height: 720
    },
    actions: {
      exportJson: ResultsApp.#onExportJson,
      applyToActors: ResultsApp.#onApplyToActors,
      closeResults: ResultsApp.#onClose,
      regenerateNarrative: ResultsApp.#onRegenerateNarrative
    }
  };

  static PARTS = {
    body: {
      template: "modules/wfrp4e-combat-simulator/templates/results.hbs",
      scrollable: [".results-scroll"]
    }
  };

  /**
   * Build the template context. Aggregates per-combatant stats into sides,
   * formats numeric distributions for display (mean/min/max/median/stddev),
   * computes side win-rate percentages, and assembles the narrative
   * section (clinical summary inline; flavor paragraph is async, fetched
   * in _onRender). The Apply button visibility is gated on canApply -
   * GM-only, engine present, and not already applied.
   */
  async _prepareContext(options) {
    const r = this.results;
    const sidesWithCombatants = {};
    for (const [cid, c] of Object.entries(r.perCombatant)) {
      sidesWithCombatants[c.sideId] ??= { id: c.sideId, name: c.sideName, combatants: [] };
      sidesWithCombatants[c.sideId].combatants.push({
        ...c,
        woundsInflicted: fmtDist(c.woundsInflicted),
        woundsReceived: fmtDist(c.woundsReceived),
        criticalsInflicted: fmtDist(c.criticalsInflicted),
        criticalsReceived: fmtDist(c.criticalsReceived),
        avgCriticalRollInflicted: c.avgCriticalRollInflicted.toFixed(1),
        avgCriticalRollReceived: c.avgCriticalRollReceived.toFixed(1),
        deathRatePct: (c.deathRate * 100).toFixed(1),
        critsReceivedDetailed: (c.critsReceivedDetailed ?? []).map(fmtCrit)
      });
    }

    const sidesArr = Object.values(sidesWithCombatants);

    // Side totals.
    for (const s of sidesArr) {
      s.winRatePct = ((r.sides[s.id]?.winRate ?? 0) * 100).toFixed(1);
      s.wins = r.sides[s.id]?.wins ?? 0;
    }

    // Narrative: clinical half is always rendered synchronously; flavor
    // half is either already cached (from a prior render in this instance)
    // or a loading placeholder that _onRender will populate async.
    const clinicalHTML = this._narrativeGen.renderClinicalSummary(this._narrativeBriefing);
    const hasApiKey = !!(game.settings.get(MODULE_ID, "anthropicApiKey") || "").trim();

    // Sim fidelity notes: skipped-effects count + standing list of WFRP4e
    // simplifications. Always shown so users can interpret results in
    // context. The skipped-effects section only renders when count > 0.
    const skipped = r.skippedEffects ?? { count: 0, paths: [] };
    const simNotes = {
      skippedEffectsCount: skipped.count,
      skippedEffectsPathsText: skipped.paths.length
        ? skipped.paths.join(", ")
        : ""
    };

    return {
      iterations: r.iterations,
      sides: sidesArr,
      predictedWinner: r.predictedWinner,
      predictedWinnerPct: r.predictedWinner ? (r.predictedWinner.winRate * 100).toFixed(1) : null,
      avgRounds: r.avgRounds.toFixed(2),
      drawRatePct: (r.drawRate * 100).toFixed(1),
      config: this.config,
      canApply: !!this.engine && !this.applied && game.user.isGM,
      applied: this.applied,
      narrative: {
        clinicalHTML,
        flavor: this._narrativeFlavor,
        flavorError: this._narrativeFlavorError,
        loading: this._narrativeLoading,
        hasApiKey
      },
      simNotes
    };
  }

  /**
   * Post-render hook. If we don't have flavor yet and an API key is
   * configured, kick off the async fetch. When it lands, we patch the
   * flavor into the DOM directly rather than re-rendering the whole
   * window (cheaper and preserves scroll position).
   */
  _onRender(context, options) {
    super._onRender?.(context, options);

    const shouldFetchFlavor =
      context.narrative?.hasApiKey &&
      this._narrativeFlavor === null &&
      this._narrativeFlavorError === null &&
      !this._narrativeLoading;

    if (shouldFetchFlavor) {
      this._loadNarrativeFlavor();
    }
  }

  /**
   * Fetch the AI flavor paragraph from the Anthropic API and cache it on
   * this instance. Sets the loading flag while the request is in flight,
   * updates flavor or error state from the result, and always repaints
   * the DOM at the end. Called once on first render (from _onRender) and
   * again on regenerate clicks.
   */
  async _loadNarrativeFlavor() {
    this._narrativeLoading = true;
    try {
      const apiKey = game.settings.get(MODULE_ID, "anthropicApiKey");
      const model = game.settings.get(MODULE_ID, "anthropicModel") || "claude-sonnet-4-6";
      const result = await this._narrativeGen.generateFlavor(
        this._narrativeBriefing,
        { apiKey, model }
      );
      if (result.text) {
        this._narrativeFlavor = result.text;
        this._narrativeFlavorError = null;
      } else {
        this._narrativeFlavor = null;
        this._narrativeFlavorError = result.error ?? "unknown";
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | narrative fetch threw`, err);
      this._narrativeFlavorError = "exception";
    } finally {
      this._narrativeLoading = false;
      this._paintNarrativeFlavor();
    }
  }

  /**
   * Update the already-rendered narrative DOM in place with whatever flavor
   * state we're now in (text, error, or nothing). Keeps scroll position and
   * avoids a full _prepareContext re-run.
   *
   * Security note: all dynamic content interpolated into the innerHTML
   * template strings below goes through foundry.utils.escapeHTML first.
   * No user-controlled raw HTML reaches the DOM. The static markup
   * (FontAwesome class names, our own i18n keys) is hardcoded.
   */
  _paintNarrativeFlavor() {
    const root = this.element;
    if (!root) return;
    const container = root.querySelector(".sim-narrative-flavor");
    if (!container) return;

    if (this._narrativeLoading) {
      container.innerHTML = `<em class="sim-narrative-loading"><i class="fas fa-spinner fa-spin"></i> Generating flavor text...</em>`;
      return;
    }
    if (this._narrativeFlavor) {
      const safe = foundry.utils.escapeHTML(this._narrativeFlavor);
      container.innerHTML = `<p>${safe}</p>`;
      return;
    }
    if (this._narrativeFlavorError) {
      const msg = this._describeFlavorError(this._narrativeFlavorError);
      container.innerHTML = `<p class="sim-narrative-flavor-error"><i class="fas fa-exclamation-triangle"></i> ${foundry.utils.escapeHTML(msg)}</p>`;
      return;
    }
    // No key, nothing to say.
    container.innerHTML = "";
  }

  /**
   * Convert an error code from _loadNarrativeFlavor into a human-readable
   * message for the user. Recognizes the canonical error codes used by
   * NarrativeGenerator.generateFlavor (no-api-key, network, empty-response,
   * api-NNN for HTTP status codes), with a fallback for anything else.
   */
  _describeFlavorError(code) {
    switch (code) {
      case "no-api-key": return "No Anthropic API key configured. Set one in the module settings to enable flavor text.";
      case "network": return "Couldn't reach the Anthropic API. Check your network connection.";
      case "cors": return "The Anthropic API request was blocked by your browser (CORS). This usually means an ad-blocker, privacy extension, or network proxy is intercepting requests to api.anthropic.com. Try disabling browser extensions for this Foundry session, or check that your network allows direct connections to api.anthropic.com.";
      case "empty-response": return "The API returned no text. Try regenerating.";
      case "exception": return "Something went wrong while generating flavor text. Try regenerating.";
      default:
        if (String(code).startsWith("api-")) {
          return `Anthropic API returned status ${String(code).slice(4)}. Check your API key and try again.`;
        }
        return `Unknown error (${code}).`;
    }
  }

  /**
   * Regenerate the AI flavor paragraph. Clears the cached flavor + error
   * state, repaints the loading spinner, then triggers a fresh API call.
   * Action handler for the regenerate button in the template.
   */
  static async #onRegenerateNarrative(event, target) {
    // Force a fresh API call.
    this._narrativeFlavor = null;
    this._narrativeFlavorError = null;
    this._paintNarrativeFlavor();
    await this._loadNarrativeFlavor();
  }

  /**
   * Export the full results object as JSON. Builds a downloadable blob
   * with a timestamped filename. Useful for archiving results across
   * Foundry sessions or comparing runs externally.
   */
  static async #onExportJson(event, target) {
    const data = JSON.stringify(this.results, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wfrp4e-sim-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Apply simulation results back to the real actor sheets. Builds a fresh
   * preview (which performs both wound and crit probabilistic rolls per
   * entry), shows the confirmation dialog with distribution bars, and on
   * confirm calls the engine to commit the writes. The preview produced
   * here is passed into the engine so the user sees the exact roll that
   * will be applied. Re-clicking Apply after Cancel intentionally re-rolls.
   *
   * Disables the button + sets applied=true on success so a single sim
   * can't be applied twice (would double-stack damage).
   */
  static async #onApplyToActors(event, target) {
    if (this.applied || !this.engine) return;

    // Build a fresh preview each click. This also performs the probabilistic
    // crit roll per actor - the roll is carried in the preview so that the
    // dialog display and the final apply stay in sync. Cancelling and
    // re-clicking Apply intentionally re-rolls (GMs can explore the distribution).
    const preview = this.engine.buildApplyPreview(this.results);
    if (!preview.length) {
      ui.notifications.warn("No actor-level results to apply.");
      return;
    }

    const confirmed = await ResultsApp._confirmApplyWithPreview(preview);
    if (!confirmed) return;

    try {
      target.disabled = true;
      target.textContent = game.i18n.localize("WFRP4E_SIM.ApplyingResults");
      // Pass the same preview we just showed so wounds and the rolled crit
      // match what the user saw. Re-fetching would produce a different roll.
      await this.engine.applyAverageResultsToActors(this.results, preview);
      this.applied = true;
      this.render();
    } catch (err) {
      console.error("WFRP4e Combat Simulator | Apply failed", err);
      ui.notifications.error(`Apply failed: ${err.message}`);
      if (target) {
        target.disabled = false;
        target.textContent = game.i18n.localize("WFRP4E_SIM.ApplyResults.Apply");
      }
    }
  }

  /** Close the results window. */
  static #onClose() { this.close(); }

  /**
   * Preview dialog: for each combatant ENTRY (not merged by actor), shows
   * the rolled wound value with its distribution, then the rolled crit
   * bucket with its distribution. Both rolls are fresh per Apply click.
   * Cancel + re-click re-rolls; Confirm commits what you see.
   */
  static _confirmApplyWithPreview(preview) {
    const rows = preview.map(p => ResultsApp._renderPreviewRow(p)).join("");

    const content = `
      <div class="sim-apply-preview">
        <p>${game.i18n.localize("WFRP4E_SIM.ApplyResults.Prompt")}</p>
        <p class="sim-apply-reroll-hint">${game.i18n.localize("WFRP4E_SIM.ApplyResults.RerollHint")}</p>
        <div class="sim-apply-rows">${rows}</div>
      </div>
    `;

    return new Promise((resolve) => {
      new DialogV2({
        window: { title: game.i18n.localize("WFRP4E_SIM.ApplyResults.Title") },
        content,
        position: { width: 640 },
        buttons: [
          {
            action: "apply",
            label: game.i18n.localize("WFRP4E_SIM.ApplyResults.ConfirmThisRoll"),
            icon: "fas fa-heart-broken",
            callback: () => resolve(true)
          },
          {
            action: "cancel",
            label: game.i18n.localize("Cancel"),
            icon: "fas fa-times",
            default: true,
            callback: () => resolve(false)
          }
        ],
        close: () => resolve(false)
      }).render(true);
    });
  }

  /**
   * Render a single combatant-entry card: name + summary line + wound
   * distribution + crit distribution.
   */
  static _renderPreviewRow(p) {
    const header = `
      <h4>${foundry.utils.escapeHTML(p.displayName ?? p.actorName)}</h4>
      <ul>
        <li>
          <i class="fas fa-heart"></i>
          Wounds: <strong>${p.currentWounds} → ${p.newWounds}</strong>
          <span class="sim-apply-meta">(−${p.rolledWounds} rolled)</span>
        </li>
      </ul>`;

    return `
      <div class="sim-apply-actor">
        ${header}
        ${ResultsApp._renderWoundDistribution(p)}
        ${ResultsApp._renderCritDistribution(p)}
      </div>
    `;
  }

  /**
   * Wound distribution section: a small histogram where each bar is one
   * observed per-iteration wound total, with the rolled sample highlighted.
   */
  static _renderWoundDistribution(p) {
    const dist = p.woundDistribution ?? [];
    if (!dist.length) {
      return `
        <div class="sim-apply-nocrits-ever">
          <i class="fas fa-shield-alt"></i>
          ${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoWoundsEver")}
        </div>`;
    }

    const bars = dist.map(b => {
      const pct = b.percent.toFixed(1);
      const barWidth = Math.max(0.5, b.percent);
      const classes = [
        "sim-dist-row",
        "sim-dist-wound",
        b.isRolled ? "sim-dist-rolled" : ""
      ].filter(Boolean).join(" ");
      const marker = b.isRolled
        ? `<i class="fas fa-caret-right sim-dist-marker" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledOutcome")}"></i>`
        : `<span class="sim-dist-marker-spacer"></span>`;
      return `
        <div class="${classes}">
          ${marker}
          <div class="sim-dist-label">${foundry.utils.escapeHTML(b.label)}</div>
          <div class="sim-dist-bar-wrap">
            <div class="sim-dist-bar" style="width: ${barWidth}%"></div>
          </div>
          <div class="sim-dist-stats">${b.count} · ${pct}%</div>
        </div>`;
    }).join("");

    const otherLine = p.woundOtherCount > 0
      ? `<div class="sim-dist-other">${game.i18n.format("WFRP4E_SIM.ApplyResults.OtherValues", { count: p.woundOtherCount })}</div>`
      : "";

    return `
      <div class="sim-dist-header">
        <span class="sim-dist-title">${game.i18n.localize("WFRP4E_SIM.ApplyResults.WoundDistribution")}</span>
        <span class="sim-apply-meta">(${p.woundTotalSamples} iterations)</span>
      </div>
      <div class="sim-dist-list">${bars}</div>
      ${otherLine}`;
  }

  /**
   * Crit distribution section (unchanged semantics from v0.1.11) - the
   * rolled bucket gets highlighted; buckets with no source UUID show an
   * amber warning.
   */
  static _renderCritDistribution(p) {
    const dist = p.critDistribution ?? [];
    const critBuckets = dist.filter(b => !b.isNoCrit);

    if (critBuckets.length === 0) {
      return `
        <div class="sim-apply-nocrits-ever">
          <i class="fas fa-shield-alt"></i>
          ${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoCritsEver")}
        </div>`;
    }

    const bars = dist.map(b => {
      const pct = b.percent.toFixed(1);
      const barWidth = Math.max(0.5, b.percent);
      const classes = [
        "sim-dist-row",
        b.isRolled ? "sim-dist-rolled" : "",
        b.isNoCrit ? "sim-dist-nocrit" : "",
        !b.isApplicable ? "sim-dist-unapplicable" : ""
      ].filter(Boolean).join(" ");
      const marker = b.isRolled
        ? `<i class="fas fa-caret-right sim-dist-marker" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledOutcome")}"></i>`
        : `<span class="sim-dist-marker-spacer"></span>`;
      const unapplicableFlag = (!b.isApplicable && !b.isNoCrit)
        ? ` <i class="fas fa-exclamation-triangle sim-dist-warning" title="${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoSourceItem")}"></i>`
        : "";
      return `
        <div class="${classes}">
          ${marker}
          <div class="sim-dist-label">${foundry.utils.escapeHTML(b.label)}${unapplicableFlag}</div>
          <div class="sim-dist-bar-wrap">
            <div class="sim-dist-bar" style="width: ${barWidth}%"></div>
          </div>
          <div class="sim-dist-stats">${b.count} · ${pct}%</div>
        </div>`;
    }).join("");

    const rolled = dist.find(b => b.isRolled);
    let rolledSummary = "";
    if (rolled) {
      if (rolled.isNoCrit) {
        rolledSummary = `<i class="fas fa-check"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.RolledNoCrit")}`;
      } else if (!rolled.isApplicable) {
        rolledSummary = `<i class="fas fa-exclamation-triangle"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.Rolled")}: <strong>${foundry.utils.escapeHTML(rolled.label)}</strong> <span class="sim-apply-meta">${game.i18n.localize("WFRP4E_SIM.ApplyResults.NoSourceWarn")}</span>`;
      } else {
        rolledSummary = `<i class="fas fa-skull"></i> ${game.i18n.localize("WFRP4E_SIM.ApplyResults.Rolled")}: <strong>${foundry.utils.escapeHTML(rolled.label)}</strong>`;
      }
    }

    return `
      <div class="sim-dist-header">
        <span class="sim-dist-title">${game.i18n.localize("WFRP4E_SIM.ApplyResults.CritDistribution")}</span>
        <span class="sim-apply-meta">(avg ${p.avgCrits.toFixed(2)}/iter, ${p.totalWeight} samples)</span>
      </div>
      <div class="sim-dist-list">${bars}</div>
      <div class="sim-dist-rolled-summary">${rolledSummary}</div>`;
  }

  /**
   * @deprecated Replaced by _confirmApplyWithPreview in v0.1.11. Kept for
   * any external callers that might still reference it; the modern path
   * (with full distribution bars) is the only one wired into the UI.
   */
  static _confirmApply() {
    // Kept for backwards compatibility / simple path.
    return new Promise((resolve) => {
      new DialogV2({
        window: { title: game.i18n.localize("WFRP4E_SIM.ApplyResults.Title") },
        content: `<p>${game.i18n.localize("WFRP4E_SIM.ApplyResults.Prompt")}</p>`,
        buttons: [
          {
            action: "apply",
            label: game.i18n.localize("WFRP4E_SIM.ApplyResults.Apply"),
            icon: "fas fa-heart-broken",
            callback: () => resolve(true)
          },
          {
            action: "cancel",
            label: game.i18n.localize("Cancel"),
            icon: "fas fa-times",
            default: true,
            callback: () => resolve(false)
          }
        ],
        close: () => resolve(false)
      }).render(true);
    });
  }
}

/**
 * Format a distStats object into display-ready strings. Mean/median use
 * decimals (some non-integer outputs make sense at the rollup level);
 * min/max are integers. Returns zero-filled strings for missing data so
 * the template never breaks on null fields.
 */
function fmtDist(d) {
  if (!d) return { mean: "0", min: "0", max: "0", median: "0", stddev: "0" };
  return {
    mean: d.mean.toFixed(2),
    min: d.min.toFixed(0),
    max: d.max.toFixed(0),
    median: d.median.toFixed(1),
    stddev: d.stddev.toFixed(2)
  };
}

/**
 * Format a crit-received entry for the results template: looks up
 * localized labels for location and severity, joins conditions with
 * stacks counts, and returns a flat object the template can render
 * directly. Falls back to raw key strings when localizations are missing.
 */
function fmtCrit(c) {
  const locKey = `WFRP4E_SIM.Location.${c.location}`;
  const sevKey = `WFRP4E_SIM.Severity.${c.severity}`;
  const locLabel = game.i18n.has(locKey) ? game.i18n.localize(locKey) : c.location;
  const sevLabel = game.i18n.has(sevKey) ? game.i18n.localize(sevKey) : c.severity;
  const condLabel = (c.conditions ?? [])
    .map(cond => cond.stacks > 1 ? `${cond.key} ×${cond.stacks}` : cond.key)
    .join(", ");
  return {
    ...c,
    locationLabel: locLabel,
    severityLabel: sevLabel,
    conditionsLabel: condLabel
  };
}
