/**
 * Effect Applier
 *
 * Translates a crit Item's Active Effects (and narrative text penalties)
 * into in-memory mutations on a Combatant's state, so that subsequent combat
 * rounds in the same iteration feel the effect.
 *
 * Design:
 *  - Only durational effects are applied. Permanent/lifetime effects are
 *    narrative and belong to post-combat GM fiat, not per-iteration sim math.
 *  - Characteristic modifiers are applied to system.characteristics.<c>.modifier
 *    which Combatant.characteristic() already reads.
 *  - Unhandled change paths are logged once per unique path per session so the
 *    user can see gaps without console spam.
 *  - Effects that target the "attacker" (as opposed to the victim) are detected
 *    via wfrp4e-specific flags and routed appropriately.
 */

const UNHANDLED_PATHS_LOGGED = new Set();

// Session-level counter of effect changes that were skipped because the
// applier didn't know how to translate them. Per-sim consumers reset this
// before running, then read it after to surface the number to users via
// the results UI ("N effects from crits couldn't be applied"). Tracks both
// the total count and a Set of unique paths for use in the UI tooltip.
let skippedEffectsCount = 0;
const skippedEffectsPaths = new Set();

/**
 * Reset the skipped-effects counters. The simulation engine calls this
 * once at the start of run() so the counter reflects only the current sim.
 */
export function resetSkippedEffectsTracking() {
  skippedEffectsCount = 0;
  skippedEffectsPaths.clear();
}

/**
 * Read the current skipped-effects summary. Returns the running total
 * count of effect changes that couldn't be applied this sim, plus a
 * sorted unique list of the change paths involved. Safe to call at any
 * time; only meaningful after a sim run completes.
 */
export function getSkippedEffectsSummary() {
  return {
    count: skippedEffectsCount,
    paths: [...skippedEffectsPaths].sort()
  };
}

// Internal normalized effect modes. We use the v13 numeric constants as our
// canonical internal representation, then normalize whatever the Active Effect
// actually carries (v13 numeric `mode` OR v14 string `type`) into one of these.
const MODE_CUSTOM     = 0;
const MODE_MULTIPLY   = 1;
const MODE_ADD        = 2;
const MODE_DOWNGRADE  = 3;
const MODE_UPGRADE    = 4;
const MODE_OVERRIDE   = 5;
// v14 introduced a dedicated SUBTRACT change type (no numeric equivalent in
// the legacy enum). We handle it as its own internal mode.
const MODE_SUBTRACT   = 6;

// Map v14 string change types to our internal modes. v14 migrated
// EffectChangeData#mode (numeric) to a string #type. The legacy numeric
// `mode` field remains readable for backward compatibility, but new/migrated
// effects expose the string form, so we accept both.
const STRING_TYPE_TO_MODE = {
  custom: MODE_CUSTOM,
  multiply: MODE_MULTIPLY,
  add: MODE_ADD,
  subtract: MODE_SUBTRACT,
  downgrade: MODE_DOWNGRADE,
  upgrade: MODE_UPGRADE,
  override: MODE_OVERRIDE
};

/**
 * Normalize an Active Effect change's mode across Foundry versions.
 *
 * v13: change.mode is a number (0-5) matching CONST.ACTIVE_EFFECT_MODES.
 * v14: change.type is a string ("add", "subtract", "multiply", "downgrade",
 *      "upgrade", "override", "custom"). The numeric change.mode may still be
 *      present for back-compat but isn't guaranteed, so prefer the string.
 *
 * Returns one of the internal MODE_* constants, defaulting to MODE_ADD when
 * neither field yields a recognized value.
 */
function _normalizeChangeMode(change) {
  // Prefer the v14 string type when present and recognized.
  if (typeof change.type === "string") {
    const m = STRING_TYPE_TO_MODE[change.type.toLowerCase()];
    if (m !== undefined) return m;
  }
  // Fall back to the v13 numeric mode.
  const n = Number(change.mode);
  if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  // Unknown / missing - default to ADD (the most common and safest).
  return MODE_ADD;
}

// Characteristic abbreviations used in wfrp4e. Also map long-form names
// used in narrative text parsing.
const CHAR_ABBREVS = ["ws", "bs", "s", "t", "i", "ag", "dex", "int", "wp", "fel"];
const CHAR_NAME_MAP = {
  "weapon skill": "ws",
  "ballistic skill": "bs",
  "strength": "s",
  "toughness": "t",
  "initiative": "i",
  "agility": "ag",
  "dexterity": "dex",
  "intelligence": "int",
  "willpower": "wp",
  "fellowship": "fel",
  "ws": "ws", "bs": "bs", "s": "s", "t": "t",
  "i": "i", "ag": "ag", "dex": "dex", "int": "int", "wp": "wp", "fel": "fel"
};

const PERMANENT_KEYWORDS = /\b(permanent|lifetime|scar|scarred|severed|amputat|forever|remov(ed|al)\s+of|lost\s+an?\s+\w+)\b/i;

/**
 * Apply a crit Item's durational effects to a Combatant.
 *
 * @param {Combatant} victim - the combatant who received the crit
 * @param {Combatant} attacker - the combatant who inflicted it (for rare
 *        attacker-targeted effects)
 * @param {Object} critItem - the cached Foundry Item document (from the
 *        warmed crit table cache)
 * @param {string} description - narrative description text
 * @returns {Array<{key, mode, value, target, path}>} applied mutations
 */
export function applyCritEffectsToCombatant(victim, attacker, critItem, description) {
  const applied = [];

  if (critItem?.effects) {
    const effects = critItem.effects.contents ?? critItem.effects;
    for (const effect of effects) {
      if (effect.disabled) continue;
      if (!_isDurational(effect)) continue;

      // Route attacker-targeted effects elsewhere. Heuristic: wfrp4e effects
      // that target the attacker tag themselves in flags.wfrp4e.applicationData
      // or have "attacker" in the effect name.
      const targetsAttacker = _effectTargetsAttacker(effect);
      const target = targetsAttacker ? attacker : victim;
      if (!target) continue;

      for (const change of effect.changes ?? []) {
        const result = _applyChange(target, change, effect);
        if (result) applied.push({ ...result, effectName: effect.name });
      }
    }
  }

  // Parse narrative text for "suffer -10 WS" style penalties.
  if (description) {
    const textEffects = _parseNarrativePenalties(description);
    for (const te of textEffects) {
      const path = `system.characteristics.${te.characteristic}.modifier`;
      _mutate(victim, path, MODE_ADD, te.modifier);
      applied.push({
        key: path, mode: MODE_ADD, value: te.modifier, target: "victim",
        path, source: "narrative-text"
      });
    }
  }

  return applied;
}

/**
 * Decide whether an Active Effect is durational (lasts for the iteration)
 * or permanent (already baked into actor stats). Priority:
 *  1. The wfrp4e "lifetime" flag is the canonical signal when present.
 *  2. Numeric duration fields (rounds/turns/seconds <= 1 hour) indicate
 *     durational effects from spells, conditions, or temporary buffs.
 *  3. Permanent-keyword pattern in the effect name (e.g. "Permanent
 *     Damage", "Old Wound") indicates baked-in.
 *  4. Default to durational - the user's stated preference is to lean
 *     toward applying effects so they don't get silently dropped.
 *
 * Why this matters: permanent effects are already in the actor's base
 * stats so re-applying them would double-count. Durational effects need
 * to be applied each iteration onto the cloned combatant.
 */
function _isDurational(effect) {
  // Explicit wfrp4e lifetime flag.
  const lifetimeFlag = effect.flags?.wfrp4e?.lifetime;
  if (lifetimeFlag === true) return false;
  if (lifetimeFlag === false) return true;

  // Duration fields set -> durational.
  const d = effect.duration ?? {};
  if (Number.isFinite(d.rounds) && d.rounds > 0) return true;
  if (Number.isFinite(d.turns) && d.turns > 0) return true;
  if (Number.isFinite(d.seconds) && d.seconds > 0 && d.seconds <= 3600) return true;

  // Permanent keywords in effect name -> permanent.
  if (PERMANENT_KEYWORDS.test(effect.name ?? "")) return false;

  // Default: durational (per user's "lean toward applying" preference).
  return true;
}

/**
 * Detect whether an effect should be applied to the attacker rather than
 * the carrier. Some wfrp4e effects ("-10 WS to attacker", "Frighten") are
 * meant to penalize whoever attacks the bearer, not the bearer themselves.
 * Checks the effect name for "attacker" and the applicationData type flag.
 */
function _effectTargetsAttacker(effect) {
  const name = (effect.name ?? "").toLowerCase();
  if (/attacker/.test(name)) return true;
  const appType = effect.flags?.wfrp4e?.applicationData?.type;
  if (appType === "attacker" || appType === "opponent") return true;
  return false;
}

/**
 * Apply a single change to the target combatant.
 * Returns applied descriptor, or null if skipped.
 */
function _applyChange(target, change, effect) {
  if (!change?.key) return null;

  const mode = _normalizeChangeMode(change);
  const rawValue = change.value;

  // Resolve value: number, string number, or WFRP bonus reference.
  const value = _resolveChangeValue(rawValue, target);
  if (value === null) {
    _logUnhandled(`value:${rawValue}`, `unparseable effect value "${rawValue}" for ${change.key}`);
    return null;
  }

  // Custom mode - we can't evaluate arbitrary system scripts.
  if (mode === MODE_CUSTOM) {
    _logUnhandled(`mode:custom`, `skipping CUSTOM mode effect "${effect.name}" on ${change.key}`);
    return null;
  }

  const path = change.key;
  if (_mutate(target, path, mode, value)) {
    return {
      key: path, mode, value,
      target: "victim",
      effectId: effect.id ?? null
    };
  }

  _logUnhandled(path, `could not apply effect on unhandled path "${path}"`);
  return null;
}

/**
 * Apply the change to target's state. Returns true if applied.
 * Supports nested system.* paths via split traversal, plus a few known
 * wfrp4e-specific paths with special handling.
 */
function _mutate(target, path, mode, value) {
  if (!path.startsWith("system.")) return false;

  const parts = path.split(".");
  // Walk to the parent.
  let parent = target;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parent == null) return false;
    if (parts[i] === "system" && i === 0) {
      parent = parent.system;
    } else {
      parent = parent[parts[i]];
    }
  }
  if (!parent || typeof parent !== "object") return false;
  const leaf = parts[parts.length - 1];

  const current = Number(parent[leaf]);
  const currentNum = Number.isFinite(current) ? current : 0;

  switch (mode) {
    case MODE_ADD:       parent[leaf] = currentNum + value; break;
    case MODE_SUBTRACT:  parent[leaf] = currentNum - value; break;
    case MODE_MULTIPLY:  parent[leaf] = currentNum * value; break;
    case MODE_DOWNGRADE: parent[leaf] = Math.min(currentNum, value); break;
    case MODE_UPGRADE:   parent[leaf] = Math.max(currentNum, value); break;
    case MODE_OVERRIDE:  parent[leaf] = value; break;
    default: return false;
  }
  return true;
}

/**
 * Parse an effect value string or number, handling SB/TB-style references.
 */
function _resolveChangeValue(raw, target) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw == null) return null;
  const s = String(raw).trim().replace(/[−–]/g, "-"); // unicode minus -> hyphen
  if (s === "") return null;
  // Pure integer.
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // "SB", "TB", "WPB", "WP", with optional +/- integer
  const mBonus = s.toUpperCase().match(/^([+-]?)(\d+)?\s*([+-]?)\s*(SB|TB|WPB|AGB|IB|DEXB|INTB|FELB|BSB|WSB)?$/);
  if (mBonus) {
    const sign1 = mBonus[1] === "-" ? -1 : 1;
    const n = mBonus[2] ? Number(mBonus[2]) * sign1 : 0;
    const sign2 = mBonus[3] === "-" ? -1 : 1;
    const bonusTerm = mBonus[4];
    let bonus = 0;
    if (bonusTerm) {
      const map = { SB: "s", TB: "t", WPB: "wp", AGB: "ag", IB: "i",
                    DEXB: "dex", INTB: "int", FELB: "fel", BSB: "bs", WSB: "ws" };
      const c = map[bonusTerm];
      if (c && target.bonus) bonus = target.bonus(c) * sign2;
    }
    return n + bonus;
  }
  return null;
}

/**
 * Parse narrative crit descriptions for "suffer -10 WS" style penalties.
 * Returns an array of { characteristic, modifier }.
 */
function _parseNarrativePenalties(text) {
  const results = [];
  if (!text) return results;
  // Normalize unicode minus/en-dash to hyphen.
  const norm = text.replace(/[−–—]/g, "-");

  // Penalty context: look for "suffer", "penalty", "reduces", "loses",
  // "receive", or a clear modifier at the start of a sentence, followed within
  // ~60 chars by a number and a characteristic reference.
  const contextWords = /(suffers?|suffering|penalty|penalties|reduces?|loses?|receives?|takes?\s+an?|has\s+an?)/i;
  const chars = "WS|BS|Ag|Ar|S|T|I|WP|Int|Fel|Dex|Weapon\\s*Skill|Ballistic\\s*Skill|Strength|Toughness|Agility|Initiative|Willpower|Intelligence|Fellowship|Dexterity";
  const modRegex = new RegExp(`([-+]\\s*\\d+|\\d+)\\s*(?:to|on|per|penalty\\s+to|modifier\\s+to)?\\s*(?:their\\s+|his\\s+|her\\s+)?(${chars})\\b`, "gi");

  let m;
  while ((m = modRegex.exec(norm)) !== null) {
    // Must have a context word within 60 chars earlier.
    const ctxWindow = norm.slice(Math.max(0, m.index - 60), m.index);
    if (!contextWords.test(ctxWindow)) continue;

    const numStr = m[1].replace(/\s+/g, "");
    let modifier = Number(numStr);
    if (!Number.isFinite(modifier)) continue;
    // If the context word is a penalty-indicator, negate a bare positive.
    if (/suffers?|penalty|reduces?|loses?/i.test(ctxWindow) && modifier > 0 && !/^[+-]/.test(numStr)) {
      modifier = -modifier;
    }

    const charKey = CHAR_NAME_MAP[m[2].toLowerCase().replace(/\s+/g, " ")];
    if (!charKey) continue;

    results.push({ characteristic: charKey, modifier });
  }

  return results;
}

/**
 * Log a warning about an Active Effect path we couldn't handle, and bump
 * the session counter so the results UI can report the total count.
 * Console-logs once per unique path/key per session to avoid spam; the
 * counter bumps every call so it reflects how many crits were partially
 * applied across all iterations.
 */
function _logUnhandled(key, message) {
  skippedEffectsCount++;
  skippedEffectsPaths.add(key);
  if (UNHANDLED_PATHS_LOGGED.has(key)) return;
  UNHANDLED_PATHS_LOGGED.add(key);
  console.warn(`WFRP4e Combat Simulator | ${message}`);
}
