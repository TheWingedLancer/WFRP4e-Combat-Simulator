/**
 * Combatant - per-iteration mutable wrapper around an Actor's data.
 * Deep-clones actor.system at construction so iteration-level state changes
 * (wound damage, advantage gain, condition stacks) don't leak back to the
 * real Actor document or to other iterations of the sim.
 */

import { evalDamageExpr } from "./rules.js";

// Weapon groups that resolve to ranged (BS) attacks. Used by weaponSkillFor
// and several callers; centralized here so the list stays consistent if
// wfrp4e ever adds a new ranged group.
export const RANGED_WEAPON_GROUPS = new Set([
  "bow", "crossbow", "blackpowder", "engineering",
  "sling", "throwing", "entangling"
]);

export class Combatant {
  constructor({ entryId, sideId, sideName, actor, startingRange }) {
    this.id = entryId ?? foundry.utils.randomID();
    this.sideId = sideId;
    this.sideName = sideName;
    this.actorId = actor.id;
    this.actorName = actor.name;
    this.actorType = actor.type;

    // Deep clone relevant system data.
    const system = foundry.utils.deepClone(actor.system ?? {});
    this.system = system;

    // Items: deep clone as plain objects, preserving system subtree.
    this.items = actor.items.map(i => ({
      id: i.id,
      name: i.name,
      type: i.type,
      system: foundry.utils.deepClone(i.system ?? {})
    }));

    // Initialise dynamic combat state. Use MAX wounds, not saved current wounds,
    // so every iteration starts each combatant fresh.
    const maxW = system?.status?.wounds?.max ?? system?.status?.wounds?.value ?? 1;
    this.state = {
      currentWounds: maxW,
      maxWounds: maxW,
      advantage: 0,
      fate: system?.status?.fate?.value ?? 0,
      fortune: system?.status?.fortune?.value ?? 0,
      resilience: system?.status?.resilience?.value ?? 0,
      resolve: system?.status?.resolve?.value ?? 0,
      criticalWounds: [],
      conditions: {},
      defending: false,
      dodging: false,
      dead: false,
      unconscious: false,
      // Per-enemy range tracking for ranged combat.
      rangeTo: {}, // targetCombatantId -> "engaged"|"short"|"medium"|"long"|"extreme"
      startingRange
    };
  }

  /* ---------------------------------- */
  /*  Queries                           */
  /* ---------------------------------- */

  /**
   * Get the current value of a characteristic by abbreviation (ws, bs, s,
   * t, i, ag, dex, int, wp, fel). Returns base + modifier; effect-applier
   * mutates the modifier field at sim time so that durational status
   * effects (e.g. -10 WS until healed) are reflected here automatically.
   * Returns 0 for unknown characteristics rather than throwing.
   */
  characteristic(abbrev) {
    const c = this.system?.characteristics?.[abbrev];
    if (!c) return 0;
    return (c.value ?? 0) + (c.modifier ?? 0);
  }

  /**
   * Characteristic bonus (the tens digit). Per WFRP4e, every characteristic
   * has an associated bonus equal to floor(value / 10); these are used as
   * direct modifiers in many places (SB on damage, TB on soak, etc.).
   */
  bonus(abbrev) {
    return Math.floor(this.characteristic(abbrev) / 10);
  }

  /**
   * Look up a skill by exact name and return its calculated total.
   * Returns { name, characteristic, advances, total } or null if not found.
   * 'total' is the characteristic value + advances - the number to roll
   * under on a d100 test.
   */
  getSkill(name) {
    const skill = this.items.find(i => i.type === "skill" && i.name === name);
    if (!skill) return null;
    const char = skill.system?.characteristic?.value ?? "ws";
    const advances = skill.system?.advances?.value ?? 0;
    return {
      name: skill.name,
      characteristic: char,
      advances,
      total: this.characteristic(char) + advances
    };
  }

  /**
   * Find the right skill to test for an attack with the given weapon.
   *
   * Algorithm:
   *  1. Natural-weapon pseudo-weapons (created from trait items, marked with
   *     `_isNaturalWeapon: true`) bypass skill lookup entirely - creature
   *     trait stat blocks don't list specialized weapon skills, so they
   *     test against raw WS/BS as indicated by the trait's
   *     rollCharacteristic field.
   *  2. For real weapons: classify melee vs ranged by weaponGroup, then
   *     try the appropriate specialization first ("Melee (Basic)" for
   *     a basic-group melee weapon, "Ranged (Bow)" for a bow-group ranged
   *     weapon). Falls back to the OTHER skill class only if the actor
   *     somehow has the cross-class one but not the expected one.
   *  3. Final fallback: raw WS or BS characteristic, no skill - matches
   *     the wfrp4e system's behavior for unskilled attacks.
   *
   * Returns: { total, characteristic, advances, name } - same shape as
   * getSkill so callers can use both interchangeably.
   */
  weaponSkillFor(weapon) {
    // Natural weapon (trait-based pseudo-weapon): no skill lookup,
    // use the rollCharacteristic that came from the trait's rollable block.
    if (weapon._isNaturalWeapon) {
      const rc = weapon._rollCharacteristic === "bs" ? "bs" : "ws";
      return {
        total: this.characteristic(rc),
        characteristic: rc,
        advances: 0,
        name: ""
      };
    }

    const groupKey = weapon.system?.weaponGroup?.value;
    const isRanged = groupKey && RANGED_WEAPON_GROUPS.has(groupKey);

    // System-defined skill name mapping if available.
    const skillName = game.wfrp4e?.config?.weaponGroups?.[groupKey];
    if (skillName) {
      // Try the expected class first (Ranged for ranged groups, Melee for
      // melee groups). Cross-class fallback only if the expected isn't on
      // the actor - rare but possible for hybrid stat blocks.
      const primary = isRanged ? `Ranged (${skillName})` : `Melee (${skillName})`;
      const secondary = isRanged ? `Melee (${skillName})` : `Ranged (${skillName})`;
      const skill = this.getSkill(primary) ?? this.getSkill(secondary);
      if (skill) return skill;
    }

    // Fallback: use raw WS/BS.
    return {
      total: this.characteristic(isRanged ? "bs" : "ws"),
      characteristic: isRanged ? "bs" : "ws",
      advances: 0,
      name: ""
    };
  }

  /**
   * Return weapons available for the combatant to use this fight.
   * For characters/NPCs, only equipped weapons count - matches sheet
   * behavior where unequipped weapons don't show up in attack rolls.
   * Creatures and vehicles bypass the equipped filter (their "weapons"
   * are body parts or built-in fittings, always available).
   */
  getWeapons() {
    const weapons = this.items.filter(i => i.type === "weapon");
    // For creatures, weapons are typically always "available" - no equipped flag semantics.
    if (this.actorType === "creature" || this.actorType === "vehicle") return weapons;
    return weapons.filter(i => {
      const eq = i.system?.equipped;
      if (typeof eq === "object" && eq !== null) return !!eq.value;
      return !!eq;
    });
  }

  /** Return all spell items on the actor (memorized + known). */
  getSpells() {
    return this.items.filter(i => i.type === "spell");
  }

  /**
   * Return natural-weapon pseudo-weapons built from damaging traits.
   *
   * A trait counts as a natural weapon when `system.rollable.damage` is
   * true. The rollable block on the trait carries every piece of
   * information the sim needs:
   *   - rollCharacteristic ("ws" -> melee, "bs" -> ranged)
   *   - bonusCharacteristic ("s" -> add Strength Bonus to the spec value,
   *     "" -> spec value is final damage)
   *   - specification.value contains the rating (may have a decorative
   *     leading "+" stripped by evalDamageExpr)
   *
   * The returned pseudo-weapons have the same shape as real weapon items
   * so the AI and engine can treat them identically. They carry three
   * extra fields to mark them:
   *   - _isNaturalWeapon: true
   *   - _rollCharacteristic: from rollable.rollCharacteristic
   *   - _bonusCharacteristic: from rollable.bonusCharacteristic
   *
   * De-duplication: if a creature has the same trait listed twice (a
   * common Foundry import quirk - the Great Taurus's two
   * `Weapon (Burning Hooves)` entries are a known example), only the
   * first occurrence is returned. WFRP4e does not grant extra attacks
   * for duplicate trait entries; multiple attacks per round require the
   * Free Attack mechanic (out of scope for v0.1.20).
   *
   * Traits with `rollable.damage` but a missing or unparseable
   * specification value are dropped - they're definitional traits, not
   * combat-actionable. The cockatrice's `Wicked Claws` (which grants
   * Damaging quality, not damage) is excluded this way: its rollable
   * block doesn't carry damage=true.
   */
  getNaturalWeapons() {
    const seen = new Set();
    const naturals = [];

    for (const trait of this.items) {
      if (trait.type !== "trait") continue;
      const rollable = trait.system?.rollable;
      if (!rollable?.damage) continue;

      // De-dupe by name.
      if (seen.has(trait.name)) continue;
      seen.add(trait.name);

      const spec = trait.system?.specification?.value;
      const sb = this.bonus("s");
      const wpb = this.bonus("wp");
      // Resolve the damage rating: spec value + bonus characteristic.
      // evalDamageExpr handles the leading "+" prefix common on creature
      // ratings ("+10" for Breath, "+4" for Bite).
      const baseDamage = evalDamageExpr(spec, sb);
      if (baseDamage === null) continue; // trait has damage flag but unparseable rating

      const bonusChar = rollable.bonusCharacteristic ?? "";
      let bonusValue = 0;
      if (bonusChar === "s") bonusValue = sb;
      else if (bonusChar === "wp") bonusValue = wpb;
      // Other bonus characteristics could be added here if wfrp4e adds them.

      const totalDamage = baseDamage + bonusValue;

      const rollChar = rollable.rollCharacteristic === "bs" ? "bs" : "ws";
      // attackType in the rollable block is unreliable (Foundry data has
      // Breath traits marked as melee). Trust rollCharacteristic - bs is
      // ranged, ws is melee.
      const isRanged = rollChar === "bs";

      naturals.push({
        id: trait.id ?? `nat-${trait.name}`,
        name: trait.name,
        type: "weapon",
        system: {
          damage: { value: totalDamage },
          // Mark with a synthetic group key so weaponGroup-based logic
          // (qualities, system-skill mapping) can still run safely. The
          // _isNaturalWeapon flag is what callers actually branch on.
          weaponGroup: { value: isRanged ? "_naturalRanged" : "_naturalMelee" },
          qualities: { value: [] },
          flaws: { value: [] },
          equipped: { value: true }
        },
        _isNaturalWeapon: true,
        _rollCharacteristic: rollChar,
        _bonusCharacteristic: bonusChar
      });
    }

    return naturals;
  }

  /**
   * Return the full list of weapons available for selection: equipped
   * weapons plus natural-weapon traits. This is what the AI uses for
   * "best weapon" selection so equipped weapons and natural weapons
   * compete on equal footing. Most actors return just their equipped
   * weapons; creatures with trait-based attacks return primarily
   * naturals; hybrids (e.g. Beastmen with both a sword and Horns) return
   * a combined list.
   */
  getAttackingWeapons() {
    return [...this.getWeapons(), ...this.getNaturalWeapons()];
  }

  /** Case-insensitive talent presence check. */
  hasTalent(name) {
    return this.items.some(i => i.type === "talent" && i.name.toLowerCase() === name.toLowerCase());
  }

  /** Case-insensitive trait presence check. */
  hasTrait(name) {
    return this.items.some(i => i.type === "trait" && i.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Compute Armour Points at a specific hit location ("head", "body",
   * "lArm", "rArm", "lLeg", "rLeg"). Walks all worn armour pieces and
   * sums their AP values for the location. Also adds the Armour trait's
   * value (which applies everywhere) when present - so creatures with
   * Armour (3) get +3 AP at every location.
   *
   * Data shape notes (v0.1.20):
   *  - Equipped flag: real NPC/PC armour items store this as
   *    `system.equipped: true` (bare boolean). Some sources use the
   *    wrapped `{value: true}` shape, others use `system.worn.value`.
   *    We accept any of the three.
   *  - AP block: the canonical shape for prepared armour data is
   *    `system.AP[location] = N` (plain integer per location). Earlier
   *    code looked at maxAP/currentAP wrapped-value shapes which only
   *    appear on unprepared/raw item data; those are kept as fallbacks
   *    but the primary read is `system.AP`.
   *  - Armour trait: rating can be in either the trait's specification
   *    value or embedded in the trait name itself (e.g. "Armour (6)").
   *    We check spec first, then fall back to the name regex.
   */
  getArmourAt(location = "body") {
    let ap = 0;
    for (const item of this.items) {
      if (item.type !== "armour") continue;
      // Accept multiple equipped-flag shapes. `equipped: true` is the
      // most common form on prepared NPC/PC actors; the others are
      // legacy/unprepared variants.
      const eq = item.system?.equipped;
      const worn = item.system?.worn;
      const isEquipped =
        (typeof eq === "boolean" && eq) ||
        (typeof eq === "object" && eq !== null && !!eq.value) ||
        (typeof worn === "boolean" && worn) ||
        (typeof worn === "object" && worn !== null && !!worn.value);
      if (!isEquipped) continue;

      // Read AP. Try the prepared-data shape first (numbers per location),
      // then the wrapped shapes for older or raw item data.
      const apBlock = item.system?.AP ?? item.system?.maxAP ?? item.system?.currentAP ?? {};
      const raw = apBlock[location];
      const apAtLoc =
        typeof raw === "number" ? raw :
        (raw && typeof raw === "object" && typeof raw.value === "number") ? raw.value :
        0;
      ap += apAtLoc;
    }
    // Traits: Armour (X) adds AP everywhere. The rating lives in
    // specification.value when the trait name is the bare "Armour" and
    // in the name itself when the trait is named "Armour (N)".
    const armourTrait = this.items.find(i => i.type === "trait" && /^armour/i.test(i.name));
    if (armourTrait) {
      const specVal = armourTrait.system?.specification?.value;
      const nameDigit = armourTrait.name.match(/\d+/)?.[0];
      const val = parseInt(specVal ?? nameDigit ?? 0);
      if (!Number.isNaN(val)) ap += val;
    }
    return ap;
  }

  /** Current Wounds for this iteration. Independent of the real actor sheet. */
  currentWounds() { return this.state.currentWounds; }

  /**
   * Combatant is alive AND conscious AND has at least 1 Wound left.
   * The AI uses this to decide whether a combatant can still take actions;
   * the engine uses it for victory checks.
   */
  isActive() {
    return !this.state.dead && !this.state.unconscious && this.state.currentWounds > 0;
  }

  isDead() { return this.state.dead; }
  hasFate() { return this.state.fate > 0; }

  /* ---------------------------------- */
  /*  Mutations                         */
  /* ---------------------------------- */

  /**
   * Apply wound damage. Drops the combatant unconscious when Wounds reach 0
   * and outright kills them when Wounds drop below -TB (matches WFRP4e p.163
   * "Wounds Beyond Zero"). Non-positive amounts are silently ignored.
   */
  takeWounds(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    this.state.currentWounds -= n;
    if (this.state.currentWounds <= 0) {
      const tb = this.bonus("t");
      // Reduced to 0: unconscious. Beyond -TB: dead.
      if (this.state.currentWounds < -tb) {
        this.state.dead = true;
      } else {
        this.state.unconscious = true;
      }
    }
  }

  /**
   * Apply a critical wound. Records it in the running list and kills the
   * combatant outright when their total criticals exceed their TB (WFRP4e
   * p.164: "Mortal Wound"). Fate-burn to survive is handled by the engine,
   * not here - this just sets the dead flag, and the engine spends Fate to
   * undo it when appropriate.
   */
  addCriticalWound(crit) {
    this.state.criticalWounds.push(crit);
    // Each crit beyond TB causes death (WFRP4e p.164).
    const tb = this.bonus("t");
    if (this.state.criticalWounds.length > tb) {
      if (this.hasFate()) {
        // Fate can be burned to survive (handled by engine).
      } else {
        this.state.dead = true;
      }
    }
  }

  spendFate() { if (this.state.fate > 0) this.state.fate--; }
  spendFortune() { if (this.state.fortune > 0) this.state.fortune--; }
  spendResolve() { if (this.state.resolve > 0) this.state.resolve--; }
  spendResilience() { if (this.state.resilience > 0) this.state.resilience--; }

  /**
   * Restore the combatant to an active state with the given wounds.
   * Used when burning Fate to survive a killing blow - the engine spends
   * the Fate point and calls revive(1) to bring them back at 1 Wound,
   * matching the WFRP4e rule.
   */
  revive(wounds = 1) {
    this.state.dead = false;
    this.state.unconscious = false;
    this.state.currentWounds = Math.max(wounds, 1);
  }

  /** Adjust Advantage by n (positive or negative), clamped to [0, 10]. */
  addAdvantage(n = 1) {
    this.state.advantage = Math.min(10, Math.max(0, this.state.advantage + n));
  }

  setAdvantage(n) { this.state.advantage = Math.max(0, n); }
  setDefending(v) { this.state.defending = v; }
  setDodging(v) { this.state.dodging = v; }

  /**
   * Add stacks of a named condition (e.g. addCondition("stunned", 2)).
   * Condition keys are lowercase strings matching wfrp4e's condition names.
   * The ConditionManager ticks these down at appropriate moments.
   */
  addCondition(name, stacks = 1) {
    this.state.conditions[name] = (this.state.conditions[name] ?? 0) + stacks;
  }

  /** Remove stacks; deletes the condition entirely when count hits 0. */
  removeCondition(name, stacks = 1) {
    if (!this.state.conditions[name]) return;
    this.state.conditions[name] -= stacks;
    if (this.state.conditions[name] <= 0) delete this.state.conditions[name];
  }

  hasCondition(name) { return (this.state.conditions[name] ?? 0) > 0; }
  conditionStacks(name) { return this.state.conditions[name] ?? 0; }

  /**
   * Set/get the current range band between this combatant and another.
   * Bands are "engaged", "short", "medium", "long", "extreme". Note:
   * range storage is one-directional - setRangeTo(B, "engaged") on A does
   * NOT auto-update B's view of A. The outnumbering helper in rules.js
   * works around this by checking both directions symmetrically.
   */
  setRangeTo(target, range) { this.state.rangeTo[target.id] = range; }
  rangeTo(target) { return this.state.rangeTo[target.id] ?? this.state.startingRange; }

  /**
   * Snapshot the combatant's current state for end-of-iteration reporting.
   * Captures everything the stats tracker needs to know about how this
   * combatant fared in this run.
   */
  snapshotStats() {
    return {
      id: this.id,
      actorId: this.actorId,
      name: this.actorName,
      sideId: this.sideId,
      currentWounds: this.state.currentWounds,
      maxWounds: this.state.maxWounds,
      alive: this.isActive(),
      criticalWoundsTaken: this.state.criticalWounds.length,
      fateRemaining: this.state.fate
    };
  }
}
