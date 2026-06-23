/**
 * Combat Simulator setup application.
 * Lets GMs assemble sides by dragging actors, configure parameters, and launch the sim.
 */

import { SimulationEngine } from "../engine/simulation-engine.js";
import { ResultsApp } from "./results-app.js";
import { warmCritTables } from "../engine/rules.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CombatSimulatorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this.sides = [
      { id: foundry.utils.randomID(), name: "Side A", combatants: [] },
      { id: foundry.utils.randomID(), name: "Side B", combatants: [] }
    ];
    this.config = {
      iterations: game.settings.get("wfrp4e-combat-simulator", "defaultIterations"),
      maxRounds: game.settings.get("wfrp4e-combat-simulator", "maxRounds"),
      victoryCondition: "incapacitation",
      startingRange: "engaged",
      applyResults: false
    };
  }

  static DEFAULT_OPTIONS = {
    id: "wfrp4e-combat-simulator",
    classes: ["wfrp4e", "wfrp4e-sim"],
    tag: "form",
    window: {
      title: "WFRP4E_SIM.Title",
      icon: "fas fa-swords",
      resizable: true
    },
    position: {
      width: 820,
      height: 720
    },
    actions: {
      addSide: CombatSimulatorApp.#onAddSide,
      removeSide: CombatSimulatorApp.#onRemoveSide,
      removeCombatant: CombatSimulatorApp.#onRemoveCombatant,
      runSimulation: CombatSimulatorApp.#onRunSimulation,
      openActor: CombatSimulatorApp.#onOpenActor
    },
    form: {
      handler: undefined,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = {
    form: {
      template: "modules/wfrp4e-combat-simulator/templates/combat-simulator.hbs",
      scrollable: [".sides-container"]
    }
  };

  /* ----------------------------------------- */
  /*  Context                                  */
  /* ----------------------------------------- */

  /**
   * Build the template context for the setup window. Carries the sides
   * array with each combatant resolved against game.actors (so we can
   * show name/image/WS/wounds preview), the current run config, the lists
   * of localization keys for victory-condition and starting-range drop-
   * downs, and a canRun flag that gates the Run button.
   */
  async _prepareContext(options) {
    return {
      sides: this.sides.map(s => ({
        ...s,
        combatantsDetailed: s.combatants.map(c => this._combatantContext(c))
      })),
      config: this.config,
      victoryConditions: {
        lastStanding: "WFRP4E_SIM.Victory.LastStanding",
        incapacitation: "WFRP4E_SIM.Victory.Incapacitation",
        rout: "WFRP4E_SIM.Victory.Rout",
        fixedRounds: "WFRP4E_SIM.Victory.FixedRounds"
      },
      startingRanges: {
        engaged: "WFRP4E_SIM.Range.Engaged",
        short: "WFRP4E_SIM.Range.Short",
        medium: "WFRP4E_SIM.Range.Medium",
        long: "WFRP4E_SIM.Range.Long",
        extreme: "WFRP4E_SIM.Range.Extreme"
      },
      canRun: this.sides.filter(s => s.combatants.length > 0).length >= 2
    };
  }

  /**
   * Resolve an entry's actorId against the game's actor list and produce
   * the display fields the setup card needs. Returns a `missing: true`
   * stub when the actor was deleted between drop and render so the UI
   * doesn't break.
   */
  _combatantContext(entry) {
    const actor = game.actors.get(entry.actorId);
    if (!actor) {
      return { id: entry.id, missing: true, name: entry.name ?? "Unknown Actor", actorId: entry.actorId };
    }
    return {
      id: entry.id,
      actorId: actor.id,
      name: actor.name,
      img: actor.img,
      type: actor.type,
      ws: actor.system?.characteristics?.ws?.value ?? "-",
      bs: actor.system?.characteristics?.bs?.value ?? "-",
      wounds: actor.system?.status?.wounds?.value ?? "-",
      woundsMax: actor.system?.status?.wounds?.max ?? "-",
      advantage: actor.system?.status?.advantage?.value ?? 0
    };
  }

  /* ----------------------------------------- */
  /*  Rendering & Drag-Drop                    */
  /* ----------------------------------------- */

  /**
   * Post-render hook. Wires up drag/drop on side dropzones, change
   * listeners on config inputs and side-name fields, and kicks off
   * background crit-table warming on the very first render. Warming is
   * fire-and-forget; if the user hits Run before it finishes, the sim
   * falls back to the slow async crit-resolution path.
   */
  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // Kick off crit-table pre-warming in the background on first render.
    // This is fire-and-forget: the sim engine falls back to the slow path
    // if the user hits Run before warming finishes. Typically warming
    // completes in <1s and subsequent sims are dramatically faster.
    if (!this._warmingStarted) {
      this._warmingStarted = true;
      warmCritTables().catch(err => {
        console.warn("WFRP4e Combat Simulator | Crit table warming failed", err);
      });
    }

    // Drop zones.
    root.querySelectorAll(".side-dropzone").forEach(zone => {
      zone.addEventListener("dragover", this._onDragOver.bind(this));
      zone.addEventListener("dragleave", this._onDragLeave.bind(this));
      zone.addEventListener("drop", this._onDrop.bind(this));
    });

    // Inputs.
    root.querySelectorAll("[data-config]").forEach(el => {
      el.addEventListener("change", this._onConfigChange.bind(this));
    });

    root.querySelectorAll("[data-side-name]").forEach(el => {
      el.addEventListener("change", this._onSideNameChange.bind(this));
    });
  }

  /** Allow drop on side dropzones (preventDefault enables the drop event). */
  _onDragOver(event) {
    event.preventDefault();
    event.currentTarget.classList.add("drop-active");
  }

  /** Remove the visual drag highlight when the drag exits. */
  _onDragLeave(event) {
    event.currentTarget.classList.remove("drop-active");
  }

  /**
   * Accept an actor drop onto a side. Reads the Foundry drag payload,
   * resolves the actor by id or UUID, and appends a new combatant entry
   * to the targeted side. Silently no-ops on malformed payloads (drags
   * from external sources) so the UI doesn't show errors for non-actor
   * drops.
   */
  async _onDrop(event) {
    event.preventDefault();
    const zone = event.currentTarget;
    zone.classList.remove("drop-active");
    const sideId = zone.dataset.sideId;

    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch (err) {
      return;
    }
    if (data?.type !== "Actor") return;

    const actor = await fromUuid(data.uuid);
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("WFRP4E_SIM.Warn.ActorNotFound"));
      return;
    }

    const side = this.sides.find(s => s.id === sideId);
    if (!side) return;

    side.combatants.push({
      id: foundry.utils.randomID(),
      actorId: actor.id,
      name: actor.name
    });

    this.render();
  }

  /**
   * Generic [data-config] input change handler. Reads the data-config key,
   * converts the value to the right type based on the input type
   * (number/checkbox/text), and writes into this.config. Does NOT re-render -
   * config inputs control sim settings only, not the displayed combatants.
   */
  _onConfigChange(event) {
    const key = event.currentTarget.dataset.config;
    let value = event.currentTarget.value;
    if (event.currentTarget.type === "number") value = Number(value);
    if (event.currentTarget.type === "checkbox") value = event.currentTarget.checked;
    this.config[key] = value;
  }

  /** Update a side's display name in place from the editable name input. */
  _onSideNameChange(event) {
    const sideId = event.currentTarget.dataset.sideName;
    const side = this.sides.find(s => s.id === sideId);
    if (side) side.name = event.currentTarget.value || side.name;
  }

  /* ----------------------------------------- */
  /*  Actions                                  */
  /* ----------------------------------------- */

  /** Add a new empty side. Names cycle A, B, C, ... up to H. */
  static #onAddSide(event, target) {
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const idx = this.sides.length;
    this.sides.push({
      id: foundry.utils.randomID(),
      name: `Side ${letters[idx] ?? idx + 1}`,
      combatants: []
    });
    this.render();
  }

  /** Remove a side. Enforces a minimum of 2 sides per WFRP4e combat. */
  static #onRemoveSide(event, target) {
    if (this.sides.length <= 2) {
      ui.notifications.warn(game.i18n.localize("WFRP4E_SIM.Warn.MinimumSides"));
      return;
    }
    const sideId = target.dataset.sideId;
    this.sides = this.sides.filter(s => s.id !== sideId);
    this.render();
  }

  /** Remove a single combatant entry from its side without affecting others. */
  static #onRemoveCombatant(event, target) {
    const sideId = target.dataset.sideId;
    const combatantId = target.dataset.combatantId;
    const side = this.sides.find(s => s.id === sideId);
    if (!side) return;
    side.combatants = side.combatants.filter(c => c.id !== combatantId);
    this.render();
  }

  /** Pop open the underlying actor sheet for convenience. */
  static #onOpenActor(event, target) {
    event.stopPropagation();
    const actorId = target.dataset.actorId;
    const actor = game.actors.get(actorId);
    actor?.sheet?.render(true);
  }

  /**
   * Kick off the simulation. Filters out empty sides, requires at least 2
   * non-empty sides, disables the Run button while running, and on
   * completion opens ResultsApp with the engine reference (so Apply can
   * call back into engine methods for the probabilistic-roll preview).
   * Surfaces errors as Foundry notifications; the engine never crashes
   * the world.
   */
  static async #onRunSimulation(event, target) {
    event.preventDefault();

    const activeSides = this.sides.filter(s => s.combatants.length > 0);
    if (activeSides.length < 2) {
      ui.notifications.error(game.i18n.localize("WFRP4E_SIM.Error.NeedTwoSides"));
      return;
    }

    // Disable button while running.
    const btn = this.element.querySelector("[data-action=runSimulation]");
    if (btn) {
      btn.disabled = true;
      btn.textContent = game.i18n.localize("WFRP4E_SIM.Running");
    }

    try {
      const engine = new SimulationEngine({
        sides: activeSides,
        config: this.config
      });
      const results = await engine.run((progress) => {
        if (btn) btn.textContent = `${game.i18n.localize("WFRP4E_SIM.Running")} ${Math.round(progress * 100)}%`;
      });

      // Show results first, then ask about applying to actors.
      new ResultsApp({ results, config: this.config, engine }).render(true);
    } catch (err) {
      console.error("WFRP4e Combat Simulator | Simulation failed", err);
      ui.notifications.error(`Simulation failed: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = game.i18n.localize("WFRP4E_SIM.Run");
      }
    }
  }
}
