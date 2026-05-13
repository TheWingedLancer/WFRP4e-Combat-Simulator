/**
 * WFRP4e rules resolution.
 *
 * These helpers implement the core mechanical flow for the simulator. They
 * roll dice using Math.random() (uniform d100) rather than routing through
 * Foundry's dice rollers, because the simulator runs thousands of iterations
 * and any chat/animation side-effect would destroy performance. The outcomes
 * are mechanically faithful to WFRP4e 4th Edition rules.
 */

const HIT_LOCATION_TABLE = [
  // 01-09 head, 10-24 left arm, 25-44 right arm, 45-79 body, 80-89 left leg, 90-100 right leg
  { max: 9, location: "head" },
  { max: 24, location: "lArm" },
  { max: 44, location: "rArm" },
  { max: 79, location: "body" },
  { max: 89, location: "lLeg" },
  { max: 100, location: "rLeg" }
];

const LOCATION_TO_ARMOUR = {
  head: "head",
  lArm: "lArm",
  rArm: "rArm",
  body: "body",
  lLeg: "lLeg",
  rLeg: "rLeg"
};

/**
 * Parse a wfrp4e weapon's damage into a numeric base. The system may prepare
 * `damage.value` to a number, but in many cases — especially for just-cloned
 * item data or older templates — `damage.value` is a string like "SB + 4" or
 * "SB+4" or "4". This helper handles all of those, plus the `meleeValue` /
 * `rangedValue` resolved fields that appear on prepared weapon data.
 *
 * Bare numerics ("4") return the literal number - they do NOT add SB.
 * WFRP4e weapons that scale with Strength Bonus use explicit "SB+N" or
 * "SB" notation; bare numbers are fixed damage (typical for ranged
 * weapons). This is the single source of truth for damage parsing
 * across the module - both the engine (for damage resolution) and the
 * AI (for "best weapon" comparisons) consume this same function.
 */
export function parseWeaponDamage(weapon, attacker) {
  const sys = weapon.system ?? {};
  const dmg = sys.damage ?? {};
  const sb = attacker.bonus("s");
  const candidates = [
    dmg.meleeValue,
    dmg.rangedValue,
    dmg.current,
    dmg.value
  ];
  for (const c of candidates) {
    if (typeof c === "number" && !Number.isNaN(c)) return c;
    if (typeof c === "string" && c.trim()) {
      const parsed = evalDamageExpr(c, sb);
      if (parsed !== null) return parsed;
    }
  }
  return 0;
}

/**
 * Evaluate a weapon damage expression like "SB + 4", "4", "SB+3", "3+SB",
 * "SB-1" into a number. Returns null on failure. Exported so callers that
 * already have an `sb` value in hand can use it directly (the AI does
 * this when comparing weapons; the engine wraps it via parseWeaponDamage).
 */
export function evalDamageExpr(expr, sb) {
  if (!expr) return null;
  // Normalise: strip whitespace, upper-case.
  const s = String(expr).replace(/\s+/g, "").toUpperCase();
  // Pure integer
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  // SB + n or n + SB, with optional sign
  const plus = s.split("+");
  if (plus.length === 2) {
    const a = plus[0] === "SB" ? sb : (/^-?\d+$/.test(plus[0]) ? parseInt(plus[0], 10) : null);
    const b = plus[1] === "SB" ? sb : (/^-?\d+$/.test(plus[1]) ? parseInt(plus[1], 10) : null);
    if (a !== null && b !== null) return a + b;
  }
  // SB - n
  if (s.includes("-")) {
    const minus = s.split("-");
    if (minus.length === 2) {
      const a = minus[0] === "SB" ? sb : (/^-?\d+$/.test(minus[0]) ? parseInt(minus[0], 10) : null);
      const b = minus[1] === "SB" ? sb : (/^-?\d+$/.test(minus[1]) ? parseInt(minus[1], 10) : null);
      if (a !== null && b !== null) return a - b;
    }
  }
  // Just "SB"
  if (s === "SB") return sb;
  return null;
}

/** Roll a d100 (1-100). */
export function d100() { return Math.floor(Math.random() * 100) + 1; }

/** Roll a d10 (1-10). */
export function d10() { return Math.floor(Math.random() * 10) + 1; }

/**
 * Compute Success Levels from a roll and target. SL is the difference in
 * tens digits between target and roll. Special cases:
 *  - Natural 1: auto-success at SL = floor(target / 10), or 0 minimum.
 *  - Natural 96-100: auto-fumble at SL = -(target tens + 1), at least -1.
 * Positive SL = success margin; negative = failure margin.
 */
export function calcSL(roll, target) {
  if (roll === 1) return Math.max(0, Math.floor(target / 10)); // auto success
  if (roll >= 96) return -Math.max(1, Math.floor(target / 10) + 1); // auto fumble
  return Math.floor(target / 10) - Math.floor(roll / 10);
}

/**
 * Detect a d100 double (tens and ones digit match). Used to trigger crits
 * on hits and miscasts on failed spells. 100 (00/00) is treated as a double.
 */
export function isDouble(n) {
  if (n === 100) return true; // 00 on both dice treated as double
  if (n < 11) return false;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return tens === ones;
}

/**
 * Swap the tens and units digits of a d100. Used for hit-location rolls:
 * WFRP4e doesn't roll a separate location die - it reverses the attack
 * roll. So if you rolled 27 to hit, the hit location is determined by 72.
 */
export function reverseRoll(n) {
  // For hit location: reverse the tens and units of the attack roll.
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  let loc = ones * 10 + tens;
  if (loc === 0) loc = 100;
  return loc;
}

/**
 * Pick the hit location from an attack roll using the WFRP4e hit-location
 * table (head 1-9, RArm 10-24, LArm 25-44, body 45-79, RLeg 80-89, LLeg
 * 90-100, reversed). Returns one of "head", "rArm", "lArm", "body",
 * "rLeg", "lLeg".
 */
export function rollHitLocation(attackRoll) {
  const reversed = reverseRoll(attackRoll);
  for (const band of HIT_LOCATION_TABLE) {
    if (reversed <= band.max) return band.location;
  }
  return "body";
}

/**
 * Resolve an opposed combat test.
 * Returns { attackerWins, winnerSL, damageDealt, hitLocation }.
 *
 * `allCombatants` is optional; when provided it enables the Outnumbering
 * to-hit bonus (core 4e p.161: +20 at 2:1, +40 at 3:1, melee only).
 */
export function resolveOpposedTest({ attacker, defender, weapon, actionType, allCombatants }) {
  // Attacker test
  const attackerSkill = attacker.weaponSkillFor(weapon);
  const attackerAdv = attacker.state.advantage * 10;
  const attackerTarget = attackerSkill.total + attackerAdv + attackerModifier(attacker, defender, weapon, actionType, allCombatants);

  const attackerRoll = d100();
  const attackerSL = calcSL(attackerRoll, attackerTarget);

  // Defender test - choose parry, dodge, or nothing.
  const defenderOption = chooseDefense(defender, attacker);
  let defenderTarget = 0;
  let defenderRoll = 0;
  let defenderSL = -99;

  if (defenderOption === "parry") {
    const defenderWeapons = defender.getWeapons();
    const parryWeapon = defenderWeapons[0];
    if (parryWeapon) {
      const defenderSkill = defender.weaponSkillFor(parryWeapon);
      defenderTarget = defenderSkill.total + defender.state.advantage * 10;
      defenderRoll = d100();
      defenderSL = calcSL(defenderRoll, defenderTarget);
    }
  } else if (defenderOption === "dodge") {
    const dodge = defender.getSkill("Dodge");
    defenderTarget = (dodge?.total ?? defender.characteristic("ag")) + defender.state.advantage * 10;
    defenderRoll = d100();
    defenderSL = calcSL(defenderRoll, defenderTarget);
  } else {
    // No defense — attacker auto-wins if they passed.
    defenderSL = -999;
  }

  const attackerPassed = attackerSL >= 0;
  const defenderPassed = defenderSL >= 0;

  let attackerWins = false;
  let winnerSL = 0;

  if (attackerPassed && !defenderPassed) {
    attackerWins = true;
    winnerSL = attackerSL - Math.min(0, defenderSL); // add magnitude of defender fumble? Standard rules: winner SL minus loser SL.
    winnerSL = attackerSL - defenderSL;
  } else if (!attackerPassed && defenderPassed) {
    attackerWins = false;
    winnerSL = defenderSL - attackerSL;
  } else if (attackerPassed && defenderPassed) {
    if (attackerSL >= defenderSL) {
      attackerWins = true;
      winnerSL = attackerSL - defenderSL;
    } else {
      attackerWins = false;
      winnerSL = defenderSL - attackerSL;
    }
    // Tie: attacker wins ties per 4e core.
    if (attackerSL === defenderSL) {
      attackerWins = true;
      winnerSL = 0;
    }
  } else {
    // Both fail - no effect.
    return { attackerWins: false, winnerSL: 0, damageDealt: 0, hitLocation: null, attackerRoll, defenderRoll };
  }

  const hitLocation = rollHitLocation(attackerRoll);

  return {
    attackerWins,
    winnerSL,
    damageDealt: attackerWins ? 1 : 0,
    hitLocation,
    attackerRoll,
    defenderRoll
  };
}

/**
 * Compute the to-hit modifier for the attacker. Sums:
 *  - Defender condition bonuses: +20 for prone (melee only), stunned,
 *    entangled, or surprised.
 *  - Attacker condition penalties: -20 prone, -40 blinded, -10/stack
 *    fatigued.
 *  - Range band penalty for ranged attacks: point +20, short +10, medium 0,
 *    long -10, extreme -30, engaged -20 (firing into melee).
 *  - Outnumbering bonus (melee only, requires allCombatants): +20 at 2:1,
 *    +40 at 3:1 - see computeOutnumberingBonus for details.
 *
 * Does NOT include the attacker's own skill or Advantage - those are
 * added by resolveOpposedTest at the call site.
 */
function attackerModifier(attacker, defender, weapon, actionType, allCombatants) {
  let mod = 0;

  // Defender prone => +20 melee
  if (defender.hasCondition("prone") && actionType === "melee") mod += 20;
  if (defender.hasCondition("stunned")) mod += 20;
  if (defender.hasCondition("entangled")) mod += 20;
  if (defender.hasCondition("surprised")) mod += 20;

  // Attacker conditions.
  if (attacker.hasCondition("prone")) mod -= 20;
  if (attacker.hasCondition("blinded")) mod -= 40;
  const fatigued = attacker.conditionStacks("fatigued");
  if (fatigued) mod -= 10 * fatigued;

  // Ranged band modifiers.
  if (actionType === "ranged") {
    const range = attacker.rangeTo(defender);
    const rangeMods = { point: 20, short: 10, medium: 0, long: -10, extreme: -30, engaged: -20 };
    mod += rangeMods[range] ?? 0;
  }

  // Outnumbering (core 4e p.161-162, melee only). Count how many active
  // combatants on each side are currently engaged with the relevant target.
  // Attacker side counts anyone on attacker.sideId (including attacker) who
  // is engaged with the defender; defender side counts anyone on
  // defender.sideId (including defender) who is engaged with the attacker.
  // The rule text: "Outnumbering is generally determined by how many
  // Characters are Engaged with each other." Ranged attacks are excluded.
  if (actionType === "melee" && allCombatants) {
    const outnumberMod = computeOutnumberingBonus(attacker, defender, allCombatants);
    mod += outnumberMod;
  }

  return mod;
}

/**
 * Count engaged combatants on both sides and return the attacker's
 * Outnumbering to-hit bonus. Ratios use strict floor division:
 *   ratio >= 3  -> +40
 *   ratio >= 2  -> +20
 *   else        ->  0
 * The attacker and defender both count toward their own side's tally.
 *
 * Engagement semantics: a combatant counts as "engaged with" another when
 * either side's stored range band is "engaged". The sim currently sets
 * rangeTo one-directionally on move, so we check both views to avoid
 * under-counting. When a pair has no explicit range set, Combatant.rangeTo
 * falls back to that combatant's startingRange - so sims configured to
 * start in "engaged" range treat everyone as a scrum by default, which
 * correctly causes the ratio to reflect the raw head-count on each side.
 */
function computeOutnumberingBonus(attacker, defender, allCombatants) {
  const engaged = (a, b) =>
    a.rangeTo(b) === "engaged" || b.rangeTo(a) === "engaged";

  let attackerSideCount = 0;
  let defenderSideCount = 0;

  for (const c of allCombatants) {
    if (!c.isActive()) continue;
    if (c.sideId === attacker.sideId) {
      // Attacker self-counts; allies count if they're engaged with the defender.
      if (c === attacker || engaged(c, defender)) {
        attackerSideCount++;
      }
    } else if (c.sideId === defender.sideId) {
      // Defender self-counts; allies count if they're engaged with the attacker.
      if (c === defender || engaged(c, attacker)) {
        defenderSideCount++;
      }
    }
    // Combatants on a third side (unusual 3-way fight) are ignored.
  }

  if (defenderSideCount <= 0) return 0; // shouldn't happen - defender is active
  const ratio = attackerSideCount / defenderSideCount;
  if (ratio >= 3) return 40;
  if (ratio >= 2) return 20;
  return 0;
}

/**
 * Pick the defender's defensive action: "parry", "dodge", or "none".
 * Explicit flags win first ("dodging" on the defender state forces dodge,
 * "defending" forces parry). Otherwise picks whichever skill is higher -
 * the weapon-skill total (parry) vs Dodge total. Inactive combatants
 * can't defend.
 */
function chooseDefense(defender, attacker) {
  if (!defender.isActive()) return "none";
  if (defender.state.dodging) return "dodge";
  if (defender.state.defending) return "parry";
  const weapons = defender.getWeapons();
  const dodge = defender.getSkill("Dodge");
  const parryTarget = weapons[0] ? defender.weaponSkillFor(weapons[0]).total : 0;
  const dodgeTarget = dodge?.total ?? 0;
  return parryTarget >= dodgeTarget ? "parry" : "dodge";
}

/**
 * Resolve damage after a successful attack.
 */
export function resolveDamage({ attacker, defender, weapon, sl, hitLocation }) {
  const sb = attacker.bonus("s");
  // parseWeaponDamage handles "SB+4" strings, meleeValue/rangedValue fields,
  // and raw numerics. It already folds SB in when the expression uses SB,
  // so we don't add sb again below when the string-form is in play.
  const parsedDamage = parseWeaponDamage(weapon, attacker);

  // Weapon flags
  const flags = weaponQualities(weapon);

  // If the raw damage.value was a *pure numeric* on an item that the system
  // hadn't prepared (rare, but possible for freshly-created items), we add SB
  // when the weapon uses SB. The parser already added SB for "SB+X" forms.
  // Heuristic: if damage.value is a string containing "SB", we trust the parse;
  // otherwise we add SB for melee weapons that use it.
  const rawDamageStr = String(weapon.system?.damage?.value ?? "");
  const alreadyIncludesSB = /SB/i.test(rawDamageStr);
  const weaponDamage = (!alreadyIncludesSB && flags.usesSB !== false)
    ? parsedDamage + sb
    : parsedDamage;

  const slDamage = Math.max(0, sl);
  let totalDamage = weaponDamage + slDamage;

  // Strike Mighty Blow: +1 damage per talent rank
  if (attacker.hasTalent("Strike Mighty Blow")) totalDamage += 1;

  // Defender mitigation.
  const tb = defender.bonus("t");
  const ap = defender.getArmourAt(hitLocation);
  let mitigation = tb + ap;

  // Hardy: +TB additional wounds absorption
  if (defender.hasTalent("Hardy")) mitigation += defender.bonus("t");

  // A successful hit always inflicts at least 1 wound. TB + AP can never
  // reduce a connecting attack's damage to 0 - the attacker won the opposed
  // test and broke through the defender's guard. The floor is applied here
  // because resolveDamage is only called after opposed.attackerWins &&
  // opposed.damageDealt > 0 upstream in _resolveAttack, so we know a real
  // hit is being resolved at this point.
  let wounds = Math.max(1, totalDamage - mitigation);
  if (!Number.isFinite(wounds)) wounds = 1;

  // Critical trigger: reducing defender to 0 or below wounds, or Impale quality.
  const preWounds = defender.currentWounds();
  const triggeredCritical = (preWounds - wounds) <= 0 || flags.impale;

  return {
    woundsDealt: wounds,
    triggeredCritical,
    hitLocation
  };
}

/**
 * Parse a weapon's qualities and flaws into a flag bag for easy lookup.
 * Returns an object with boolean fields for each relevant quality:
 *  - impact: doubles a die for damage on doubles
 *  - impale: triggers crit on doubles when SL >= 0
 *  - damaging: replaces ones digit of damage roll with the higher value
 *  - hack: location-specific crit modifier
 *  - fast: -10 to opponent's defense
 *  - slow: +10 to opponent's defense (this is a Flaw, not a Quality)
 *  - usesSB: true unless the weapon is a ranged weapon group that
 *    doesn't add Strength Bonus to damage (bows, crossbows, blackpowder)
 */
function weaponQualities(weapon) {
  const qualities = weapon.system?.qualities?.value ?? [];
  const flaws = weapon.system?.flaws?.value ?? [];
  const qualityNames = (Array.isArray(qualities) ? qualities : []).map(q => (q.name ?? q)?.toLowerCase?.() ?? "");
  const flawNames = (Array.isArray(flaws) ? flaws : []).map(q => (q.name ?? q)?.toLowerCase?.() ?? "");

  return {
    impact: qualityNames.some(n => n.includes("impact")),
    impale: qualityNames.some(n => n.includes("impale")),
    damaging: qualityNames.some(n => n.includes("damaging")),
    hack: qualityNames.some(n => n.includes("hack")),
    fast: qualityNames.some(n => n.includes("fast")),
    slow: flawNames.some(n => n.includes("slow")),
    usesSB: !qualityNames.some(n => n.includes("blackpowder") || n.includes("bow") || n.includes("crossbow"))
  };
}

/**
 * Location -> wfrp4e critical table key mapping.
 * The wfrp4e core exposes these standard tables; GMs can install Up in Arms
 * or other supplements that register alternative tables via modules.
 */
const LOCATION_TO_CRIT_TABLE = {
  head: "crithead",
  body: "critbody",
  lArm: "critarm",
  rArm: "critarm",
  lLeg: "critleg",
  rLeg: "critleg"
};

/**
 * Conditions that appear commonly in the wfrp4e crit table text.
 * Keyed by the word as it appears in the description; value is the
 * canonical condition id recognised by ConditionManager.
 */
const CRIT_CONDITION_PATTERNS = [
  { regex: /\bbleeding\b/i,    key: "bleeding",    captureStacks: /bleeding\s*\+?(\d+)/i },
  { regex: /\bstunned\b/i,     key: "stunned",     captureStacks: /stunned\s*\+?(\d+)/i },
  { regex: /\bprone\b/i,       key: "prone",       captureStacks: null },
  { regex: /\bblinded\b/i,     key: "blinded",     captureStacks: /blinded\s*\+?(\d+)/i },
  { regex: /\bdeafened\b/i,    key: "deafened",    captureStacks: /deafened\s*\+?(\d+)/i },
  { regex: /\bfatigued\b/i,    key: "fatigued",    captureStacks: /fatigued\s*\+?(\d+)/i },
  { regex: /\bentangled\b/i,   key: "entangled",   captureStacks: null },
  { regex: /\bbroken\b/i,      key: "broken",      captureStacks: /broken\s*\+?(\d+)/i },
  { regex: /\bablaze\b/i,      key: "ablaze",      captureStacks: null },
  { regex: /\bunconscious\b/i, key: "unconscious", captureStacks: null }
];

/**
 * Cache of resolved crit Items across a single page session.
 * UUID -> { name, description, extraWounds, conditions }
 */
const CRIT_ITEM_CACHE = new Map();

/**
 * Pre-built synchronous crit table: tableKey -> sorted array of
 *   { min, max, uuid, name, description, extraWounds, conditions }
 *
 * When populated, rollCriticalWound can run entirely synchronously - no
 * awaits, no system calls, no chat-message overhead. Populated by
 * warmCritTables() which should be called once when the Combat Simulator
 * UI opens.
 */
const CRIT_TABLE_CACHE = new Map();

/**
 * Pre-load all crit tables and their referenced Items into memory.
 *
 * wfrp4e exposes the raw RollTable documents through game.tables (world-level)
 * and through compendiums. We read the .results collection to build our own
 * synchronous lookup, avoiding the cost of going through tables.rollTable on
 * every simulation crit (which evaluates a Roll, awaits, and calls the
 * deprecated getChatText internally).
 *
 * Safe to call multiple times - short-circuits if already warmed.
 * Returns a Promise that resolves when all four tables are ready (or failed).
 */
export async function warmCritTables() {
  if (CRIT_TABLE_CACHE.size > 0) return true; // already warmed

  const tableKeys = ["crithead", "critbody", "critarm", "critleg"];
  let anyLoaded = false;

  for (const key of tableKeys) {
    try {
      const table = findCritTable(key);
      if (!table) continue;

      // Walk the table's results and build the lookup array.
      // v13 TableResult shape: {name, description, documentUuid, range, type, img}.
      // Legacy fields (text, documentCollection, documentId) are deprecated.
      const entries = [];
      const resultsIter = table.results?.contents ?? table.results ?? [];
      for (const r of resultsIter) {
        const range = r.range;
        if (!range || range.length < 2) continue;
        const [min, max] = range;

        const uuid = r.documentUuid ?? null;
        let name = r.name ?? "";

        // Resolve the linked Item for description + extra wounds + conditions + effects.
        // This is done ONCE per unique UUID during warmup.
        let description = "";
        let extraWounds = 0;
        let conditions = [];
        let item = null;
        if (uuid) {
          const resolved = await resolveCritItem(uuid);
          if (resolved) {
            description = resolved.description;
            extraWounds = resolved.extraWounds;
            conditions = resolved.conditions;
            item = resolved.item;
            if (resolved.name) name = resolved.name;
          }
        }

        entries.push({ min, max, uuid, name, description, extraWounds, conditions, item });
      }

      entries.sort((a, b) => a.min - b.min);
      if (entries.length > 0) {
        CRIT_TABLE_CACHE.set(key, entries);
        anyLoaded = true;
        console.log(`WFRP4e Combat Simulator | Warmed ${key}: ${entries.length} entries`);
      } else {
        console.warn(`WFRP4e Combat Simulator | Crit table ${key} found but had no parseable entries`);
      }
    } catch (err) {
      console.warn(`WFRP4e Combat Simulator | Failed to warm crit table ${key}`, err);
    }
  }

  if (!anyLoaded) {
    console.warn("WFRP4e Combat Simulator | No crit tables could be warmed; simulations will use the slow async path.");
  }
  return anyLoaded;
}

/**
 * Find a wfrp4e crit RollTable by its key/name. Checks world tables first,
 * then the wfrp4e system's table registry.
 */
function findCritTable(key) {
  // wfrp4e registers these via game.wfrp4e.tables[key]: a plain data object,
  // not a proper RollTable. We need the underlying document.
  // First try game.tables (world RollTables collection).
  if (game.tables) {
    const hit = game.tables.find(t => t.name?.toLowerCase().includes(key)
                                   || t.getFlag?.("wfrp4e", "key") === key);
    if (hit) return hit;
  }

  // Fall back to wfrp4e's registered table structure.
  const wt = game?.wfrp4e?.tables?.[key];
  if (wt) {
    // This is typically a plain object with columns/rows - wrap it so
    // the results walker can process it.
    if (wt.results) return wt;
    if (wt.columns && Array.isArray(wt.columns)) {
      // Build a synthetic entries array from the column data.
      return { results: wt.columns.flatMap(c => c.rows ?? []) };
    }
  }

  return null;
}

/**
 * Fetch and cache a crit-table item by UUID. The wfrp4e system stores
 * critical wounds as world Items with description, wounds, and condition
 * data. This async lookup is slow (uses fromUuid which may hit the world
 * database) so results are cached in a module-level Map keyed by UUID.
 * Failures cache null so we don't retry on every iteration.
 *
 * Returns { name, description, extraWounds, conditions, item } or null
 * when the item can't be resolved.
 */
async function resolveCritItem(uuid) {
  if (!uuid) return null;
  if (CRIT_ITEM_CACHE.has(uuid)) return CRIT_ITEM_CACHE.get(uuid);

  let resolved = null;
  try {
    const item = await fromUuid(uuid);
    if (item) {
      const description = stripHTML(item.system?.description?.value ?? "");
      const woundsRaw = item.system?.wounds?.value
        ?? item.system?.damage?.value
        ?? 0;
      const extraWounds = Number(woundsRaw) || 0;
      const conditions = extractConditionsFromItem(item, description);
      resolved = { name: item.name ?? "", description, extraWounds, conditions, item };
    }
  } catch (err) {
    // Cache null so we don't retry.
  }

  CRIT_ITEM_CACHE.set(uuid, resolved);
  return resolved;
}

/**
 * Roll a critical wound.
 *
 * If the crit tables have been warmed (via warmCritTables), this is fully
 * synchronous and extremely fast - just a d100 and an array lookup. If not
 * warmed, falls back to the async wfrp4e tables.rollTable path which is
 * ~200x slower but still correct.
 */
export async function rollCriticalWound(hitLocation) {
  const tableKey = LOCATION_TO_CRIT_TABLE[hitLocation] ?? "critbody";
  const roll = d100();

  // FAST PATH: warmed synchronous lookup.
  const entries = CRIT_TABLE_CACHE.get(tableKey);
  if (entries) {
    const entry = entries.find(e => roll >= e.min && roll <= e.max);
    if (entry) {
      return {
        result: roll,
        location: hitLocation,
        tableKey,
        name: entry.name,
        description: entry.description,
        extraWounds: entry.extraWounds,
        conditions: entry.conditions,
        uuid: entry.uuid,
        item: entry.item,
        severity: roll <= 20 ? "minor" : roll <= 60 ? "serious" : roll <= 90 ? "major" : "lethal"
      };
    }
  }

  // SLOW PATH: tables weren't warmed, use the system's async roller.
  return await rollCriticalWoundViaSystem(hitLocation, tableKey, roll);
}

/**
 * Async fallback path for resolving a crit when the synchronous warm-cache
 * lookup didn't have the table. Calls the wfrp4e system's rollTable API
 * to draw a real result from the RollTable, then resolves any embedded
 * UUID reference via resolveCritItem for the description and conditions.
 *
 * Slower than the cached path because rollTable involves database I/O
 * and the UUID resolution chains another async fetch. The sim engine
 * warms the cache on UI open to avoid this path in normal operation;
 * this only fires when a never-seen-before crit table is hit during a
 * sim that wasn't pre-warmed.
 *
 * Returns the same shape as the warm-cache resolveCritical: { result,
 * location, tableKey, name, description, extraWounds, conditions, uuid,
 * severity }.
 */
async function rollCriticalWoundViaSystem(hitLocation, tableKey, fallbackRoll) {
  let roll = fallbackRoll;
  let name = "";
  let description = "";
  let extraWounds = 0;
  let conditions = [];
  let uuid = null;

  const tables = game?.wfrp4e?.tables;
  if (tables && typeof tables.rollTable === "function") {
    try {
      const res = await tables.rollTable(tableKey);
      if (res) {
        if (Number.isFinite(res.total)) roll = res.total;
        else if (Number.isFinite(res.roll)) roll = res.roll;

        name = res.name ?? res.text ?? "";

        uuid = extractUuidFromResultString(res.result);
        const cached = await resolveCritItem(uuid);
        if (cached) {
          if (cached.name) name = cached.name;
          description = cached.description;
          extraWounds = cached.extraWounds;
          conditions = cached.conditions;
        }

        if (!description && name) description = name;
        if (conditions.length === 0) conditions = extractConditionsFromText(`${name} ${description}`);
      }
    } catch (err) {
      console.warn("WFRP4e Combat Simulator | crit table roll failed, using severity bucket only", err);
    }
  }

  return {
    result: roll,
    location: hitLocation,
    tableKey,
    name,
    description,
    extraWounds,
    conditions,
    uuid,
    severity: roll <= 20 ? "minor" : roll <= 60 ? "serious" : roll <= 90 ? "major" : "lethal"
  };
}

/**
 * Extract the UUID from a wfrp4e rollTable result string like
 * "@UUID[Compendium.wfrp4e-core.items.Item.sSSUZXOXK2DSpxGx]{Dramatic Injury}".
 * Returns null if the string isn't a UUID reference.
 */
function extractUuidFromResultString(str) {
  if (!str || typeof str !== "string") return null;
  const match = str.match(/@UUID\[([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Extract conditions from a crit Item's active effects (if present) or from
 * the narrative description text as a fallback. wfrp4e crit items often carry
 * Active Effects whose names match condition keys.
 */
function extractConditionsFromItem(item, description) {
  const found = [];
  const seen = new Set();
  const effects = item.effects ?? [];
  for (const effect of effects) {
    const nm = (effect.name ?? "").toLowerCase();
    for (const pat of CRIT_CONDITION_PATTERNS) {
      if (pat.regex.test(nm) && !seen.has(pat.key)) {
        seen.add(pat.key);
        found.push({ key: pat.key, stacks: 1 });
      }
    }
  }
  // Also scan the description for any conditions not captured by effects.
  const textFound = extractConditionsFromText(description);
  for (const c of textFound) {
    if (!seen.has(c.key)) {
      seen.add(c.key);
      found.push(c);
    }
  }
  return found;
}

/**
 * Strip HTML tags from a string and collapse whitespace. Used to clean
 * crit-item descriptions stored as Foundry rich text before showing them
 * in the results UI or passing to the narrative generator.
 */
function stripHTML(str) {
  if (!str) return "";
  return String(str).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Parse condition mentions out of crit description text by pattern matching.
 * Used as a fallback when a crit Item doesn't expose its conditions as
 * Active Effects - we look in the description prose for phrases like
 * "Bleeding 2" or "Stunned" and extract them with stacks counts.
 * Returns an array of { key, stacks } condition descriptors.
 */
function extractConditionsFromText(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  for (const pat of CRIT_CONDITION_PATTERNS) {
    if (!pat.regex.test(text)) continue;
    if (seen.has(pat.key)) continue;
    seen.add(pat.key);
    let stacks = 1;
    if (pat.captureStacks) {
      const m = text.match(pat.captureStacks);
      if (m && Number.isFinite(Number(m[1]))) stacks = Number(m[1]);
    }
    found.push({ key: pat.key, stacks });
  }
  return found;
}
