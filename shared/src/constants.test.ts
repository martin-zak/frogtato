import { describe, expect, it } from 'vitest';
import {
  enemyCap,
  enemyHpMultiplier,
  playerFactor,
  spawnInterval,
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
