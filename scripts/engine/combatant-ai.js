/**
 * CombatantAI - default action-selection logic.
 *
 * Heuristics:
 *  - If engaged, attack with best-damage melee weapon.
 *  - If caster with a damage spell and sufficient WP, cast it.
 *  - If has ranged weapon and an enemy is not engaged, shoot.
 *  - If out of range, move closer.
 *  - If heavily wounded (<=25% wounds), consider defending.
 */

import { parseWeaponDamage } from "./rules.js";
import { RANGED_WEAPON_GROUPS } from "./combatant.js";

export class CombatantAI {
  /**
   * Pick what action this combatant should take this turn. Returns an action
   * descriptor object the engine can act on, or null when there are no
   * enemies to act against.
   *
   * Decision order (each step short-circuits if it returns):
   *  1. Cast a damage spell, if the combatant has one and WP >= 35
   *     (35 minimum because lower WP makes most damage spells unreliable
   *     and the AI is better off swinging).
   *  2. Melee attack, if engaged and a melee weapon is equipped. Sets
   *     `defending: true` on the action when current wounds <= 25% of max,
   *     so the engine knows this combatant is fighting cautiously.
   *  3. Ranged attack, if NOT engaged and a ranged weapon is equipped.
   *  4. Move one range band closer, if NOT engaged but melee weapons are
   *     equipped (combatant is closing to engage).
   *  5. Unarmed fallback: use a weapon-trait pseudo-weapon if present,
   *     else just defend this turn.
   *  6. Last resort: attack with whatever weapon is in hand, melee if
   *     engaged otherwise ranged.
   *
   * @param self           the acting combatant
   * @param enemies        all currently active enemies
   * @param allCombatants  full combatant list (unused here, passed for symmetry)
   * @returns action descriptor: { type, weapon?, spell?, target?, newRange?, defending? }
   */
  chooseAction(self, enemies, allCombatants) {
    if (!enemies.length) return null;

    const target = this._chooseTarget(self, enemies);
    // Unified weapon list: equipped weapons + natural-weapon traits.
    // Real weapons and natural attacks compete on equal footing in
    // _bestWeapon's damage sort; the tie-break in _bestWeapon prefers
    // primary attacks (real weapons, "Weapon (X)" traits) over Free
    // Attack-style trait weapons (Bite, Tail Attack, etc.) so creatures
    // with multiple natural attacks pick the right primary.
    const weapons = self.getAttackingWeapons();
    const spells = self.getSpells();

    const meleeWeapons = weapons.filter(w => this._isMelee(w));
    const rangedWeapons = weapons.filter(w => this._isRanged(w));

    const currentRange = self.rangeTo(target);
    const engaged = currentRange === "engaged";

    // Low wounds: defensive posture (but still attack).
    const lowHealth = self.currentWounds() <= Math.ceil(self.state.maxWounds * 0.25);

    // Caster logic: prefer damaging spells if available and WP is high.
    if (spells.length > 0 && self.characteristic("wp") >= 35) {
      const damageSpell = this._bestDamageSpell(spells);
      if (damageSpell) {
        return { type: "cast", spell: damageSpell, target };
      }
    }

    // Engaged - melee.
    if (engaged && meleeWeapons.length > 0) {
      const weapon = this._bestWeapon(self, meleeWeapons);
      return { type: "melee", weapon, target, defending: lowHealth };
    }

    // Ranged enemy not engaged.
    if (!engaged && rangedWeapons.length > 0) {
      const weapon = this._bestWeapon(self, rangedWeapons);
      return { type: "ranged", weapon, target };
    }

    // Move to close.
    if (!engaged && meleeWeapons.length > 0) {
      const nextRange = this._closeOneStep(currentRange);
      return { type: "move", target, newRange: nextRange };
    }

    // No usable weapons of any kind, no spells - all that's left is defend.
    // The v0.1.20 unified weapon list folds in natural weapons, so the
    // previous "find a trait that vaguely looks like a weapon" fallback
    // from earlier versions is no longer needed and has been removed.
    if (meleeWeapons.length === 0 && rangedWeapons.length === 0) {
      return { type: "defend" };
    }

    // Fall-through: attack with whatever we have.
    const fallbackWeapon = this._bestWeapon(self, weapons);
    return { type: engaged ? "melee" : "ranged", weapon: fallbackWeapon, target };
  }

  /**
   * Pick a target from the enemy list. Heuristic: focus the most wounded
   * enemy first (finish them off), break ties by highest WS (drop the most
   * dangerous fighter when health is equal).
   */
  _chooseTarget(self, enemies) {
    // Prefer lowest current wounds (easy kill), break ties by highest advantage threat.
    return [...enemies].sort((a, b) => {
      if (a.currentWounds() !== b.currentWounds()) return a.currentWounds() - b.currentWounds();
      return (b.characteristic("ws") ?? 0) - (a.characteristic("ws") ?? 0);
    })[0];
  }

  /**
   * Sort weapons by computed damage and return the highest-damage one.
   * Damage parsing delegates to the shared rules.parseWeaponDamage so
   * the AI and the engine score weapons identically.
   *
   * Tie-breaker priority (when damage values are equal):
   *  1. Real equipped weapons - assumed to be the actor's primary attack.
   *  2. "Weapon (X)" trait pseudo-weapons - per the rulebook these are
   *     the creature's primary attack ("carries a melee weapon, or uses
   *     teeth, claws, or similar").
   *  3. Other natural-weapon traits (Bite, Tail Attack, Tongue Attack,
   *     Tentacles, Horns, Hooves, etc.) - these are most often Free
   *     Attacks per the rulebook, and should not be preferred over the
   *     primary attack when damage is equal.
   *
   * Free Attack mechanics themselves are out of scope for v0.1.20 - the
   * AI just picks the best primary attack each turn. Cockatrice example:
   * Talons / Bite / Tail Attack all resolve to 7 damage; this tie-break
   * makes the AI correctly pick Talons (Weapon trait, primary) over
   * Bite (Free Attack) and Tail Attack (Free Attack).
   */
  _bestWeapon(self, weapons) {
    const tieRank = (w) => {
      if (!w._isNaturalWeapon) return 0; // real weapon: best
      if (/^Weapon\b/i.test(w.name)) return 1; // "Weapon (X)" trait: primary natural
      return 2; // other natural attack: typically a Free Attack in the rules
    };
    return [...weapons].sort((a, b) => {
      const damageDiff = parseWeaponDamage(b, self) - parseWeaponDamage(a, self);
      if (damageDiff !== 0) return damageDiff;
      return tieRank(a) - tieRank(b);
    })[0];
  }

  /** Return the highest-damage damaging spell, or null if none. */
  _bestDamageSpell(spells) {
    return [...spells]
      .filter(s => (s.system?.damage?.value ?? 0) > 0)
      .sort((a, b) => (b.system?.damage?.value ?? 0) - (a.system?.damage?.value ?? 0))[0] ?? null;
  }

  /**
   * Classify a weapon as melee or ranged.
   *
   * Three paths in priority order:
   *  1. Natural-weapon pseudo-weapons (from getNaturalWeapons): check the
   *     `_rollCharacteristic` flag set from the trait's rollable block.
   *     `bs` -> ranged, anything else -> melee. The synthetic
   *     `_naturalMelee` / `_naturalRanged` group keys would also work but
   *     reading the rollCharacteristic is the authoritative source.
   *  2. Real weapons with a known weaponGroup: ranged groups (bow,
   *     crossbow, blackpowder, engineering, sling, throwing, entangling)
   *     are ranged; everything else is melee.
   *  3. Unknown groups default to melee.
   */
  _isMelee(weapon) {
    if (weapon._isNaturalWeapon) {
      return weapon._rollCharacteristic !== "bs";
    }
    const group = weapon.system?.weaponGroup?.value;
    return !RANGED_WEAPON_GROUPS.has(group);
  }

  _isRanged(weapon) {
    return !this._isMelee(weapon);
  }

  /**
   * Walk one step closer in the range progression. Used when a combatant
   * wants to close to melee. WFRP4e bands shrink toward "engaged" as you
   * approach: extreme -> long -> medium -> short -> engaged.
   */
  _closeOneStep(range) {
    const order = ["extreme", "long", "medium", "short", "engaged"];
    const idx = order.indexOf(range);
    if (idx === -1) return "engaged";
    return order[Math.min(order.length - 1, idx + 1)];
  }
}
