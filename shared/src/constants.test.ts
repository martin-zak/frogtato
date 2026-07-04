import { describe, expect, it } from 'vitest';
import {
  classBaseStats,
  DEFAULT_CLASS,
  ENEMY_DEFS,
  enemyCap,
  enemyHpMultiplier,
  FROG_CLASSES,
  mergeResultLevel,
  MERGEABLE_LEVELS,
  playerFactor,
  spawnInterval,
  STAT_SHOP_OFFERS,
  WAVES,
  WEAPON_DEFS,
} from './constants.js';

describe('scaling formulas', () => {
  it('enemyCap(5, 1) === 28', () => {
    expect(enemyCap(5, 1)).toBe(28);
  });

  it('playerFactor(4) === 2.8', () => {
    expect(playerFactor(4)).toBeCloseTo(2.8);
  });

  it('enemyHpMultiplier(1) === 1', () => {
    expect(enemyHpMultiplier(1)).toBe(1);
  });

  it('enemyHpMultiplier(5) === 2', () => {
    expect(enemyHpMultiplier(5)).toBe(2);
  });

  it('spawnInterval(1) === 1.5', () => {
    expect(spawnInterval(1)).toBeCloseTo(1.5);
  });

  it('spawnInterval(5) === 0.5', () => {
    expect(spawnInterval(5)).toBeCloseTo(0.5);
  });
});

describe('weapon level scaling', () => {
  it('tongue lash Lv III damage === 5 * 2.4 = 12', () => {
    expect(WEAPON_DEFS.tongueLash.levels[3].damage).toBeCloseTo(12);
  });

  it('tongue lash Lv II damage === 5 * 1.6 = 8, cooldown === 0.8 * 0.9 = 0.72', () => {
    expect(WEAPON_DEFS.tongueLash.levels[2].damage).toBeCloseTo(8);
    expect(WEAPON_DEFS.tongueLash.levels[2].cooldownSec).toBeCloseTo(0.72);
  });

  it('bubble blaster Lv III damage === 3 * 2.4 = 7.2, cooldown === 1.0 * 0.8 = 0.8', () => {
    expect(WEAPON_DEFS.bubbleBlaster.levels[3].damage).toBeCloseTo(7.2);
    expect(WEAPON_DEFS.bubbleBlaster.levels[3].cooldownSec).toBeCloseTo(0.8);
  });

  it('croak nova Lv II damage === 2 * 1.6 = 3.2, cooldown === 2.5 * 0.9 = 2.25', () => {
    expect(WEAPON_DEFS.croakNova.levels[2].damage).toBeCloseTo(3.2);
    expect(WEAPON_DEFS.croakNova.levels[2].cooldownSec).toBeCloseTo(2.25);
  });

  it('Lv I stats are unscaled', () => {
    expect(WEAPON_DEFS.tongueLash.levels[1].damage).toBe(5);
    expect(WEAPON_DEFS.tongueLash.levels[1].cooldownSec).toBe(0.8);
  });
});

describe('Phase 2 frog classes', () => {
  it('DEFAULT_CLASS is treefrog', () => {
    expect(DEFAULT_CLASS).toBe('treefrog');
  });

  it('bullfrog effective maxHp === 20 + 8 = 28', () => {
    expect(classBaseStats('bullfrog').maxHp).toBe(28);
  });

  it('treefrog effective moveSpeed === 220 * 1.15 = 253', () => {
    expect(classBaseStats('treefrog').moveSpeed).toBeCloseTo(253);
  });

  it('dartfrog effective damagePct === 0 + 0.15 = 0.15, maxHp === 20 - 6 = 14', () => {
    expect(classBaseStats('dartfrog').damagePct).toBeCloseTo(0.15);
    expect(classBaseStats('dartfrog').maxHp).toBe(14);
  });

  it('each class has a starting weapon and display name', () => {
    for (const id of ['bullfrog', 'treefrog', 'dartfrog'] as const) {
      const def = FROG_CLASSES[id];
      expect(def.displayName.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(['tongueLash', 'bubbleBlaster', 'croakNova']).toContain(def.startingWeapon);
    }
  });
});

describe('Phase 2 new stat shop offers', () => {
  it('buyArmor: 14 flies, +8 each, cap 3', () => {
    const offer = STAT_SHOP_OFFERS.find((o) => o.id === 'buyArmor')!;
    expect(offer.cost).toBe(14);
    expect(offer.priceIncrement).toBe(8);
    expect(offer.maxPurchases).toBe(3);
  });

  it('buyRegen: 12 flies, +6 each, cap 3', () => {
    const offer = STAT_SHOP_OFFERS.find((o) => o.id === 'buyRegen')!;
    expect(offer.cost).toBe(12);
    expect(offer.priceIncrement).toBe(6);
    expect(offer.maxPurchases).toBe(3);
  });

  it('buyPickupRadius: 8 flies, +4 each, cap 4, +15px per buy', () => {
    const offer = STAT_SHOP_OFFERS.find((o) => o.id === 'buyPickupRadius')!;
    expect(offer.cost).toBe(8);
    expect(offer.priceIncrement).toBe(4);
    expect(offer.maxPurchases).toBe(4);
    expect(offer.effect).toEqual({ stat: 'pickupRadius', amount: 15 });
  });
});

describe('Phase 2 weapon merging', () => {
  it('I+I -> II, II+II -> III, III cannot merge', () => {
    expect(mergeResultLevel(1)).toBe(2);
    expect(mergeResultLevel(2)).toBe(3);
    expect(mergeResultLevel(3)).toBeNull();
  });

  it('MERGEABLE_LEVELS is [1, 2]', () => {
    expect(MERGEABLE_LEVELS).toEqual([1, 2]);
  });
});

describe('Phase 2 heron', () => {
  it('hp 8, telegraph 0.8s, swoop damage 4, drops 4 flies (2026-07-04 economy tuning), appears wave 3+', () => {
    const heron = ENEMY_DEFS.heron;
    expect(heron.hp).toBe(8);
    expect(heron.telegraphSec).toBe(0.8);
    expect(heron.swoopDamage).toBe(4);
    expect(heron.flyDrop).toBe(4);
    expect(heron.minWave).toBe(3);
  });

  it('WAVES: heron absent before wave 3, present from wave 3', () => {
    expect(WAVES[0].spawnMix.heron).toBe(0);
    expect(WAVES[1].spawnMix.heron).toBe(0);
    expect(WAVES[2].spawnMix.heron).toBeGreaterThan(0);
    expect(WAVES[3].spawnMix.heron).toBeGreaterThan(0);
    expect(WAVES[4].spawnMix.heron).toBeGreaterThan(0);
  });
});

describe('Phase 2 Snail King boss', () => {
  it('hp 120 base, speed 40, 3-glob spread every 2s', () => {
    const boss = ENEMY_DEFS.snailKing;
    expect(boss.hp).toBe(120);
    expect(boss.speed).toBe(40);
    expect(boss.spreadCount).toBe(3);
    expect(boss.spreadIntervalSec).toBe(2);
  });

  it('shell phase: 2s duration, Armor 5', () => {
    const boss = ENEMY_DEFS.snailKing;
    expect(boss.shellDurationSec).toBe(2);
    expect(boss.shellArmor).toBe(5);
  });

  it('spawns in wave 5, last 20s, hard cap +30s', () => {
    const boss = ENEMY_DEFS.snailKing;
    expect(boss.spawnWave).toBe(5);
    expect(boss.spawnAtRemainingSec).toBe(20);
    expect(boss.hardCapExtraSec).toBe(30);
  });

  it('WAVES flags wave 5 as the boss wave and only wave 5', () => {
    expect(WAVES.map((w) => w.bossWave)).toEqual([false, false, false, false, true]);
  });
});
