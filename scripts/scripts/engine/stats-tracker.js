/**
 * StatsTracker
 *
 * Accumulates per-iteration combat outcomes and produces the aggregate
 * summary: per-participant means, min/max/median/stddev, and side win rates.
 */

export class StatsTracker {
  constructor(sides) {
    this.sides = sides;

    // For every individual combatant entry (by entry.id — stable across iterations),
    // a raw-samples array of per-iteration tallies.
    this.perCombatant = {};
    for (const side of sides) {
      for (const entry of side.combatants) {
        this.perCombatant[entry.id] = {
          entryId: entry.id,
          actorId: entry.actorId,
          name: entry.name,
          sideId: side.id,
          sideName: side.name,
          woundsInflicted: [],
          woundsReceived: [],
          criticalsInflicted: [],
          criticalsReceived: [],
          criticalRolls: [],   // all crit d100 results this combatant inflicted
          critRollsReceived: [],
          critDetailsReceived: [], // full crit objects received
          miscasts: [],
          killsInflicted: [],
          diedInIter: [],
          // Per-iteration flag (0 or 1) for whether this combatant received
          // ZERO crits that iteration. Summing gives the "no crit" bucket
          // weight for probabilistic Apply.
          zeroCritIterationFlags: []
        };
      }
    }

    // Side win counters.
    this.sideWins = {};
    this.draws = 0;

    // Combat length samples.
    this.roundsPerCombat = [];

    // Loadout info per combatant entry - captured once by the engine
    // before iterations start. Lives on this.loadouts[entryId] and gets
    // merged into the per-combatant summary for the narrative generator.
    this.loadouts = {};

    // Temporary per-iteration accumulator reset on each iteration.
    this._currentIterAcc = null;
  }

  /**
   * Store a loadout descriptor for a given combatant entry. Called once
   * at sim startup. Idempotent - if called multiple times, the last call
   * wins.
   */
  recordLoadout(entryId, loadout) {
    this.loadouts[entryId] = loadout;
  }

  /**
   * Called by the engine at the end of each iteration. Flushes the per-iter
   * accumulator into the permanent records on this.perCombatant, records
   * the iteration's winning side and round count, and resets for the next
   * iteration. The engine should have invoked recordAttack/Damage/Critical
   * etc. during the iteration; this is just the final commit.
   */
  recordIteration(outcome) {
    // The engine has already called recordAttack/Damage/Critical/Miscast during
    // the iteration, populating _currentIterAcc. Just flush it to permanent
    // records and reset for the next iteration.
    this._flushCurrentIteration(outcome);
  }

  // ---- Called by the engine during an iteration ----

  /**
   * Record that an attack was thrown (regardless of hit/miss outcome).
   * Currently does nothing - we don't track raw attack counts - but
   * exists so the engine can call it without an existence check, and so
   * future stats (hit rate per combatant) can be added without changing
   * engine call sites.
   */
  recordAttack(attacker, defender) {
    this._ensureAcc();
    // Nothing stored per-attack unless we care about attack count later.
  }

  /**
   * Record that `attacker` dealt `wounds` wounds to `defender` on a hit.
   * This is the symmetric call - the same wound count increments the
   * attacker's "inflicted" and the defender's "received" counters in one
   * shot, so the two are always consistent.
   */
  recordDamage(attacker, defender, wounds) {
    this._ensureAcc();
    this._bumpAcc(attacker.id, "woundsInflicted", wounds);
    this._bumpAcc(defender.id, "woundsReceived", wounds);
  }

  /**
   * Record a critical wound. `critRoll` may be a bare number (the d100
   * roll on the crit table) for legacy compatibility, OR a full crit
   * object { result, location, name, description, conditions, uuid }
   * preferred path. The crit object form is what enables probabilistic
   * Apply to attach the right embedded item later.
   */
  recordCritical(attacker, defender, critRoll) {
    this._ensureAcc();
    // critRoll can be either a bare number (legacy) or a full crit object.
    const rollNum = typeof critRoll === "number" ? critRoll : critRoll?.result ?? 0;
    const critObj = typeof critRoll === "number"
      ? { result: critRoll, location: "body", name: "", description: "", conditions: [] }
      : critRoll;

    this._bumpAcc(attacker.id, "criticalsInflicted", 1);
    this._bumpAcc(defender.id, "criticalsReceived", 1);
    this._pushAcc(attacker.id, "criticalRolls", rollNum);
    this._pushAcc(defender.id, "critRollsReceived", rollNum);
    this._pushAcc(defender.id, "critDetailsReceived", critObj);
  }

  /** Record a miscast event by a caster (any severity). */
  recordMiscast(caster) {
    this._ensureAcc();
    this._bumpAcc(caster.id, "miscasts", 1);
  }

  // ---- Internal: per-iteration accumulator ----

  /** Lazy-init the per-iteration accumulator. Called by every recordXxx. */
  _ensureAcc() {
    if (!this._currentIterAcc) this._startIterAccumulator();
  }

  /**
   * Initialize a fresh accumulator object with zero counters for every
   * tracked combatant. Called at the start of each iteration via
   * _ensureAcc when the first event fires.
   */
  _startIterAccumulator() {
    this._currentIterAcc = {};
    for (const id of Object.keys(this.perCombatant)) {
      this._currentIterAcc[id] = {
        woundsInflicted: 0,
        woundsReceived: 0,
        criticalsInflicted: 0,
        criticalsReceived: 0,
        criticalRolls: [],
        critRollsReceived: [],
        critDetailsReceived: [],
        miscasts: 0
      };
    }
    return this._currentIterAcc;
  }

  /** Add to a numeric counter in the current iteration's accumulator. */
  _bumpAcc(id, key, amount) {
    if (!this._currentIterAcc || !this._currentIterAcc[id]) return;
    this._currentIterAcc[id][key] += amount;
  }

  /** Append to an array counter in the current iteration's accumulator. */
  _pushAcc(id, key, value) {
    if (!this._currentIterAcc || !this._currentIterAcc[id]) return;
    this._currentIterAcc[id][key].push(value);
  }

  /**
   * Move the iteration's accumulator into the permanent per-combatant
   * records: one summed sample per metric per iteration. Also records the
   * iteration's winning side (or draw), round count, zero-crit flags for
   * probabilistic Apply, and per-combatant death flags. Clears the
   * accumulator so the next iteration starts fresh.
   */
  _flushCurrentIteration(outcome) {
    const acc = this._currentIterAcc ?? this._startIterAccumulator();

    for (const [id, tally] of Object.entries(acc)) {
      const rec = this.perCombatant[id];
      rec.woundsInflicted.push(tally.woundsInflicted);
      rec.woundsReceived.push(tally.woundsReceived);
      rec.criticalsInflicted.push(tally.criticalsInflicted);
      rec.criticalsReceived.push(tally.criticalsReceived);
      rec.criticalRolls.push(...tally.criticalRolls);
      rec.critRollsReceived.push(...tally.critRollsReceived);
      rec.critDetailsReceived.push(...tally.critDetailsReceived);
      rec.miscasts.push(tally.miscasts);

      // Track whether this combatant received no crits this iteration.
      // This feeds the "No crit" bucket in probabilistic Apply sampling.
      rec.zeroCritIterationFlags.push(tally.criticalsReceived === 0 ? 1 : 0);

      // Did this combatant die this iteration? Check snapshot by combatant id.
      const snap = outcome.combatants.find(c => c.id === id);
      rec.diedInIter.push(snap && !snap.alive ? 1 : 0);
    }

    this.roundsPerCombat.push(outcome.rounds);

    if (outcome.winner && outcome.winner !== "draw") {
      this.sideWins[outcome.winner] = (this.sideWins[outcome.winner] ?? 0) + 1;
    } else {
      this.draws++;
    }

    this._currentIterAcc = null;
  }

  /**
   * Build the final aggregate report after all iterations are complete.
   * This is the public output of the tracker - everything downstream
   * (results UI, narrative generator, Apply) reads this shape:
   *
   * {
   *   iterations:    total iteration count,
   *   perCombatant:  { entryId -> per-combatant rollup with distStats fields },
   *   sides:         { sideId -> { id, name, wins, winRate } },
   *   draws:         iterations with no winner,
   *   drawRate:      draws / iterations,
   *   avgRounds:     mean combat length,
   *   predictedWinner: { id, name, winRate } of the highest-win-rate side, or null
   * }
   *
   * Each per-combatant entry carries distStats (mean/min/max/median/stddev)
   * for wounds and crits, raw wound samples for probabilistic Apply, a
   * loadout descriptor for the narrative generator, and a deathRate
   * (fraction of iterations in which they died).
   */
  summarize(totalIterations) {
    const perCombatant = {};
    for (const [id, rec] of Object.entries(this.perCombatant)) {
      perCombatant[id] = {
        entryId: id,
        actorId: rec.actorId,
        name: rec.name,
        sideId: rec.sideId,
        sideName: rec.sideName,
        woundsInflicted: distStats(rec.woundsInflicted),
        woundsReceived: distStats(rec.woundsReceived),
        // Raw per-iteration wound samples, preserved so probabilistic Apply
        // can draw one at random rather than applying the rounded mean.
        // Each entry is the total wounds received in that iteration (possibly 0).
        woundsReceivedSamples: [...rec.woundsReceived],
        criticalsInflicted: distStats(rec.criticalsInflicted),
        criticalsReceived: distStats(rec.criticalsReceived),
        avgCriticalRollInflicted: mean(rec.criticalRolls),
        avgCriticalRollReceived: mean(rec.critRollsReceived),
        critsReceivedDetailed: summarizeCritsReceived(rec.critDetailsReceived),
        // Number of iterations in which this combatant received ZERO crits.
        // Used as the "No crit" bucket weight for probabilistic Apply.
        iterationsWithZeroCritsReceived: rec.zeroCritIterationFlags.reduce((a, b) => a + b, 0),
        miscasts: distStats(rec.miscasts),
        deathRate: mean(rec.diedInIter),
        loadout: this.loadouts[id] ?? null
      };
    }

    // Per-side win rates and predicted winner.
    const sideStats = {};
    let winner = null;
    let winnerRate = 0;
    for (const side of this.sides) {
      const wins = this.sideWins[side.id] ?? 0;
      const rate = wins / totalIterations;
      sideStats[side.id] = {
        id: side.id,
        name: side.name,
        wins,
        winRate: rate
      };
      if (rate > winnerRate) {
        winnerRate = rate;
        winner = side;
      }
    }

    return {
      iterations: totalIterations,
      perCombatant,
      sides: sideStats,
      draws: this.draws,
      drawRate: this.draws / totalIterations,
      avgRounds: mean(this.roundsPerCombat),
      predictedWinner: winner ? {
        id: winner.id,
        name: winner.name,
        winRate: winnerRate
      } : null
    };
  }
}

/** Arithmetic mean of an array of numbers. Returns 0 for empty arrays. */
function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Median of an array of numbers. Returns 0 for empty arrays. */
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sample standard deviation (n-1 denominator). Returns 0 for arrays with
 * fewer than 2 samples. Used over population stddev because each iteration
 * is a sample from the underlying distribution.
 */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * Build the distribution summary for an array of per-iteration samples.
 * Returns { mean, min, max, median, stddev, samples } - the canonical
 * shape every downstream consumer expects. Returns zero-filled stats for
 * empty input rather than NaN/null, simplifying display code.
 */
function distStats(arr) {
  if (!arr.length) return { mean: 0, min: 0, max: 0, median: 0, stddev: 0, samples: 0 };
  return {
    mean: mean(arr),
    min: Math.min(...arr),
    max: Math.max(...arr),
    median: median(arr),
    stddev: stddev(arr),
    samples: arr.length
  };
}

/**
 * Group identical crits (same location + same numeric roll) so the display
 * can show frequencies rather than a wall of duplicates.
 * Sorts by frequency descending, then by severity descending.
 */
function summarizeCritsReceived(details) {
  if (!details?.length) return [];
  const buckets = new Map();
  for (const c of details) {
    const key = `${c.location}:${c.result}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        count: 0,
        location: c.location,
        result: c.result,
        name: c.name,
        description: c.description,
        severity: c.severity,
        conditions: c.conditions ?? [],
        uuid: c.uuid ?? null
      });
    }
    buckets.get(key).count++;
  }
  return [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.result - a.result;
  });
}
