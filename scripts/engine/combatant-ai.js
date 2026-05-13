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
    const weapons = self.getWeapons();
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

    // Has melee weapon but currently only has ranged situation and no ammo? Default: defend.
    if (meleeWeapons.length === 0 && rangedWeapons.length === 0) {
      // Unarmed - use trait weapon if any, else defend.
      const weaponTrait = self.items.find(i => i.type === "trait" && /weapon/i.test(i.name));
      if (weaponTrait) {
        const pseudo = {
          id: weaponTrait.id,
          name: weaponTrait.name,
          type: "weapon",
          system: {
            damage: { value: parseInt(weaponTrait.system?.specification?.value ?? 0) || 0 },
            weaponGroup: { value: "basic" },
            qualities: { value: [] },
            flaws: { value: [] },
            equipped: { value: true }
          }
        };
        return { type: "melee", weapon: pseudo, target };
      }
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
   * Damage parsing handles all the wfrp4e formats: numeric values, "SB",
   * "SB+4", "4+SB", and string-encoded numbers. Strength Bonus is folded
   * in once here so weapons are comparable on equal footing.
   */
  _bestWeapon(self, weapons) {
    const sb = self.bonus("s");
    const damageOf = (w) => {
      const d = w.system?.damage ?? {};
      const candidates = [d.meleeValue, d.rangedValue, d.current, d.value];
      for (const c of candidates) {
        if (typeof c === "number" && !Number.isNaN(c)) return c;
        if (typeof c === "string") {
          const s = c.replace(/\s+/g, "").toUpperCase();
          if (/^-?\d+$/.test(s)) return parseInt(s, 10) + sb;
          if (s === "SB") return sb;
          const m = s.match(/^SB([+-])(\d+)$/) || s.match(/^(\d+)([+-])SB$/);
          if (m) {
            if (m[0].startsWith("SB")) return sb + (m[1] === "+" ? 1 : -1) * parseInt(m[2], 10);
            return parseInt(m[1], 10) + (m[2] === "+" ? 1 : -1) * sb;
          }
        }
      }
      return 0;
    };
    return [...weapons].sort((a, b) => damageOf(b) - damageOf(a))[0];
  }

  /** Return the highest-damage damaging spell, or null if none. */
  _bestDamageSpell(spells) {
    return [...spells]
      .filter(s => (s.system?.damage?.value ?? 0) > 0)
      .sort((a, b) => (b.system?.damage?.value ?? 0) - (a.system?.damage?.value ?? 0))[0] ?? null;
  }

  /**
   * Classify a weapon as melee or ranged by its weaponGroup. The list of
   * ranged groups matches what the WFRP4e system itself uses internally.
   */
  _isMelee(weapon) {
    const group = weapon.system?.weaponGroup?.value;
    const rangedGroups = ["bow", "crossbow", "blackpowder", "engineering", "sling", "throwing", "entangling"];
    return !rangedGroups.includes(group);
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
