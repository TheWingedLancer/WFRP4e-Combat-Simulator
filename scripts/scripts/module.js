/**
 * WFRP4e Combat Simulator
 * Monte Carlo combat simulation for Warhammer Fantasy Roleplay 4th Edition.
 */

import { CombatSimulatorApp } from "./apps/combat-simulator-app.js";
import { SimulationEngine } from "./engine/simulation-engine.js";
import { CombatantAI } from "./engine/combatant-ai.js";
import { ResultsApp } from "./apps/results-app.js";

const MODULE_ID = "wfrp4e-combat-simulator";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  // Expose API for macros and other modules. The open() entry point
  // guards against missing-system worlds; the engine/AI/results classes
  // are still exported so external code can reuse them for their own
  // wfrp4e-system-aware tooling without going through the UI.
  game.modules.get(MODULE_ID).api = {
    open: () => {
      if (blockedNoSystem()) return;
      new CombatSimulatorApp().render(true);
    },
    SimulationEngine,
    CombatantAI,
    ResultsApp
  };

  // Module settings.
  game.settings.register(MODULE_ID, "defaultIterations", {
    name: "WFRP4E_SIM.Settings.DefaultIterations.Name",
    hint: "WFRP4E_SIM.Settings.DefaultIterations.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 1000,
    range: { min: 10, max: 10000, step: 10 }
  });

  game.settings.register(MODULE_ID, "maxRounds", {
    name: "WFRP4E_SIM.Settings.MaxRounds.Name",
    hint: "WFRP4E_SIM.Settings.MaxRounds.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 20,
    range: { min: 5, max: 100, step: 1 }
  });

  game.settings.register(MODULE_ID, "suppressChatMessages", {
    name: "WFRP4E_SIM.Settings.SuppressChat.Name",
    hint: "WFRP4E_SIM.Settings.SuppressChat.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Anthropic API key for AI-generated narrative flavor text. Client-scoped
  // so keys are NEVER synced to player browsers; only the GM who entered the
  // key has it. The clinical summary works without an API key configured.
  game.settings.register(MODULE_ID, "anthropicApiKey", {
    name: "WFRP4E_SIM.Settings.AnthropicApiKey.Name",
    hint: "WFRP4E_SIM.Settings.AnthropicApiKey.Hint",
    scope: "client",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "anthropicModel", {
    name: "WFRP4E_SIM.Settings.AnthropicModel.Name",
    hint: "WFRP4E_SIM.Settings.AnthropicModel.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "claude-sonnet-4-6"
  });
});

// Set true at ready time when the wfrp4e system is detected. The module's
// UI hooks check this and refuse to render buttons or open the simulator
// without the system, because every code path downstream assumes wfrp4e
// data shapes (weaponGroup, characteristic abbrevs, crit tables). With no
// system, the sim would either silently produce garbage or throw on a
// random later call - strict-mode fails loudly instead.
let systemReady = false;

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Ready`);
  if (game.wfrp4e) {
    systemReady = true;
  } else {
    ui.notifications.error(
      "WFRP4e Combat Simulator requires the wfrp4e system. " +
      "The simulator is disabled on this world."
    );
  }

  migrateStaleModelSetting();
});

/**
 * Upgrade a stale Anthropic model string saved in client settings.
 *
 * The default model shipped with the module changes over time as Anthropic
 * retires older models. Changing the registered default only affects users
 * who never touched the setting - anyone who has a value saved (including the
 * old default that was auto-saved) keeps their stale string and would send a
 * retired model id to the API, producing a confusing 404. We remap known dead
 * defaults to the current one. We deliberately DON'T touch values the user
 * clearly chose themselves (anything not in the dead-defaults list), so a GM
 * who intentionally selected a specific model keeps their choice.
 */
function migrateStaleModelSetting() {
  // Model ids that were prior shipped defaults and are now retired/invalid.
  // Only these auto-upgrade; bespoke user choices are left alone.
  const DEAD_DEFAULTS = new Set([
    "claude-sonnet-4-5",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-latest"
  ]);
  const CURRENT_DEFAULT = "claude-sonnet-4-6";

  try {
    const current = game.settings.get(MODULE_ID, "anthropicModel");
    if (DEAD_DEFAULTS.has(current)) {
      game.settings.set(MODULE_ID, "anthropicModel", CURRENT_DEFAULT);
      console.log(
        `${MODULE_ID} | Migrated retired narrative model "${current}" to "${CURRENT_DEFAULT}"`
      );
    }
  } catch (err) {
    // Setting not registered yet or other access error - non-fatal.
    console.warn(`${MODULE_ID} | Model setting migration skipped`, err);
  }
}

/**
 * Guard - return true and warn the user if the wfrp4e system isn't loaded.
 * Used by every entry point that would interact with sim machinery.
 */
function blockedNoSystem() {
  if (systemReady) return false;
  ui.notifications.error(
    "WFRP4e Combat Simulator requires the wfrp4e system. " +
    "Activate the wfrp4e game system on this world to use the simulator."
  );
  return true;
}

/**
 * Add a scene control button for GMs.
 * v13: controls is an object keyed by control name; tools is an object keyed by tool name.
 */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools) return;

  tokenControls.tools["wfrp4e-combat-sim"] = {
    name: "wfrp4e-combat-sim",
    title: "WFRP4E_SIM.OpenSimulator",
    icon: "fas fa-swords",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    // Hidden entirely on non-wfrp4e worlds - the simulator is unusable
    // without the system, so the button shouldn't exist to be misclicked.
    // Same caveat as the actor-sidebar button: check game.wfrp4e directly
    // because this hook can fire before our own ready hook flips systemReady.
    visible: game.user.isGM && !!game.wfrp4e,
    onChange: () => {
      const existing = foundry.applications.instances.get("wfrp4e-combat-simulator");
      if (existing) existing.close();
      else game.modules.get(MODULE_ID).api.open();
    }
  };
});

/**
 * Add a button to the Actors sidebar. Inserts into the same action group
 * as Foundry's native "Create Actor" / "Create Folder" buttons so it
 * inherits the native button appearance.
 */
Hooks.on("renderActorDirectory", (app, html) => {
  if (!game.user.isGM) return;
  // Strict mode: only attach button on wfrp4e worlds. Checking game.wfrp4e
  // directly rather than the systemReady flag because the renderActorDirectory
  // hook can fire BEFORE the ready hook on world load - by that point
  // game.wfrp4e is already populated by Foundry's system loader, but our
  // own systemReady flag hasn't been flipped yet.
  if (!game.wfrp4e) return;

  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  if (root.querySelector(".wfrp4e-sim-open")) return;

  // v13 sidebar: directory-header > .action-buttons contains the create buttons.
  // Fallbacks handle older layouts where the directory-header itself is the host.
  const actionGroup =
    root.querySelector(".directory-header .action-buttons") ??
    root.querySelector(".header-actions") ??
    root.querySelector(".directory-header");

  if (!actionGroup) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wfrp4e-sim-open";
  // Security note: innerHTML usage is safe here - the only dynamic part
  // is the i18n key "WFRP4E_SIM.OpenSimulator" which is resolved from our
  // own lang/en.json bundled in the module. No user input touches this.
  btn.innerHTML = `<i class="fas fa-swords"></i> ${game.i18n.localize("WFRP4E_SIM.OpenSimulator")}`;
  btn.addEventListener("click", () => game.modules.get(MODULE_ID).api.open());
  actionGroup.appendChild(btn);
});
