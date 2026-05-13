/**
 * Combatant - a per-iteration mutable wrapper around an Actor's data.
 * NEVER mutates the real Actor document.
 */

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
   * Tries the system's weapon-group → skill mapping first (e.g. weapon
   * group "basic" maps to skill "Basic", so the skill checked is
   * "Melee (Basic)"). Falls back to raw WS/BS characteristic when no
   * skill is found on the actor - matches what the WFRP4e system itself
   * does for unskilled attacks.
   *
   * Returns: { total, characteristic, advances, name } - same shape as
   * getSkill so callers can use both interchangeably.
   */
  weaponSkillFor(weapon) {
    const groupKey = weapon.system?.weaponGroup?.value;
    // System-defined skill name mapping if available.
    const skillName = game.wfrp4e?.config?.weaponGroups?.[groupKey];
    if (skillName) {
      const skill = this.getSkill(`Melee (${skillName})`) ?? this.getSkill(`Ranged (${skillName})`);
      if (skill) return skill;
    }
    // Fallback: use raw WS/BS.
    const isRanged = weapon.system?.weaponGroup?.value && ["bow", "crossbow", "blackpowder", "engineering", "sling", "throwing", "entangling"].includes(weapon.system.weaponGroup.value);
    return { total: this.characteristic(isRanged ? "bs" : "ws"), characteristic: isRanged ? "bs" : "ws", advances: 0, name: "" };
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
   */
  getArmourAt(location = "body") {
    let ap = 0;
    for (const item of this.items) {
      if (item.type !== "armour") continue;
      const equipped = item.system?.worn?.value ?? item.system?.equipped?.value;
      if (!equipped) continue;
      const locations = item.system?.maxAP ?? item.system?.currentAP ?? {};
      const apAtLoc = locations[location]?.value ?? locations[location];
      if (typeof apAtLoc === "number") ap += apAtLoc;
    }
    // Traits: Armour (X) adds AP everywhere.
    const armourTrait = this.items.find(i => i.type === "trait" && /^armour/i.test(i.name));
    if (armourTrait) {
      const val = parseInt(armourTrait.system?.specification?.value ?? armourTrait.name.match(/\d+/)?.[0] ?? 0);
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
