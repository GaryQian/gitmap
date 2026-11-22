import { describe, expect, it } from 'vitest';
import { createReplica } from '../../model';
import { cityRef, districtRef, unitRef, type NodeRef, type Tour, type TourFrame, type TourStep, type UnitRef } from '../../model/types';
import { syntheticBatch } from '../../testing/synthetic';
import { clearDistance, type Box } from './framing';
import {
  NO_TOUR, currentStep, frameTarget, goTo, isLastStep, next, offeredTour, prev, start, stepsValid, stop, tourChanged, type TourState,
} from './sequence';

const step = (file: string, text = `About ${file}`, highlights: UnitRef[] = [], frame: TourFrame = 'file'): TourStep =>
  ({ parent: `u:${file}`, frame, text, highlights });
const tourOf = (id: string, ...steps: TourStep[]): Tour => ({ type: 'tour', id, steps });
const four = tourOf('t1', step('a.ts'), step('b.ts'), step('c.ts'), step('d.ts'));
const offered = (tour: Tour): TourState => tourChanged(NO_TOUR, tour);
const playingAt = (tour: Tour, index: number): TourState => goTo(start(offered(tour)), index);

describe('tour sequencing', () => {
  it('starts at the first step, and only when there is a tour', () => {
    expect(start(NO_TOUR)).toBe(NO_TOUR);
    const playing = start(offered(four));
    expect(playing).toMatchObject({ active: true, index: 0 });
    expect(currentStep(playing)).toBe(four.steps[0]);
    expect(start(next(playing))).toMatchObject({ index: 1 }); // already playing: start changes nothing
    expect(currentStep(offered(four))).toBeNull();
  });

  it('steps forwards and backwards within bounds', () => {
    const first = start(offered(four));
    expect(prev(first)).toBe(first);
    const second = next(first);
    expect(second.index).toBe(1);
    expect(prev(second).index).toBe(0);
    expect(goTo(first, 3).index).toBe(3);
    for (const bad of [-1, 4, 1.5, NaN]) expect(goTo(first, bad)).toBe(first);
    // nothing moves while the tour is not playing
    const idle = offered(four);
    expect(next(idle)).toBe(idle);
    expect(goTo(idle, 2)).toBe(idle);
  });

  it('finishes on the last step, and the next start begins again', () => {
    const last = playingAt(four, 3);
    expect(isLastStep(last)).toBe(true);
    expect(isLastStep(playingAt(four, 2))).toBe(false);
    const done = next(last);
    expect(done).toEqual({ tour: four, index: 0, active: false });
    expect(start(done)).toMatchObject({ active: true, index: 0 });
    expect(stop(playingAt(four, 2))).toEqual(done);
  });

  it('a changed tour keeps the step on screen when it still exists', () => {
    const at = playingAt(four, 2); // on c.ts
    // an equal tour is no change at all
    expect(tourChanged(at, tourOf('t1', ...four.steps.map((s) => ({ ...s }))))).toBe(at);
    // an earlier step went away: the same step, one place earlier
    const shorter = tourOf('t1', four.steps[0]!, four.steps[2]!, four.steps[3]!);
    expect(tourChanged(at, shorter)).toEqual({ tour: shorter, index: 1, active: true });
    // regenerated with new wording, same place and file: stay
    const reworded = tourOf('t2', step('a.ts', 'x'), step('b.ts', 'y'), step('c.ts', 'z'));
    expect(tourChanged(at, reworded)).toEqual({ tour: reworded, index: 2, active: true });
  });

  it('a changed tour restarts when the step is gone, and a removed tour stops it', () => {
    const at = playingAt(four, 2);
    const other = tourOf('t2', step('x.ts'), step('y.ts'), step('z.ts'));
    expect(tourChanged(at, other)).toEqual({ tour: other, index: 0, active: true });
    expect(tourChanged(at, null)).toEqual(NO_TOUR);
    expect(tourChanged(at, tourOf('t3'))).toEqual(NO_TOUR);
    // while not playing, the new tour simply replaces the old one
    expect(tourChanged(offered(four), other)).toEqual({ tour: other, index: 0, active: false });
  });
});

describe('tour steps against the model', () => {
  const replica = createReplica();
  replica.apply(syntheticBatch({ files: 60, seed: 3 }));
  const units = replica.table('unit');
  const [unitA, unitB] = units.ids.slice(0, 2).map((id) => unitRef(id!)) as [UnitRef, UnitRef];
  const gone: UnitRef = 'u:no/such/file.ts';
  const say = (parent: NodeRef, highlights: NodeRef[] = [], frame: TourFrame = 'file'): TourStep =>
    ({ parent: parent as UnitRef, frame, text: 'text', highlights: highlights as UnitRef[] });

  it('drops steps whose file no longer exists, and highlights that are gone', () => {
    const district = districtRef(replica.table('district').ids[0]!);
    // a step must stand on a file: a district as parent, or a malformed ref, is dropped like a missing file
    const tour = tourOf('t', say(unitA), say(gone), say(unitB, [unitA]), say(unitA, [unitB, gone, district]), say(district), say('nonsense' as NodeRef));
    const { steps, enough } = stepsValid(tour, replica);
    expect(steps.map((s) => s.parent)).toEqual([unitA, unitB, unitA]);
    expect(steps[2]!.highlights).toEqual([unitB]);
    expect(steps[1]).toBe(tour.steps[2]); // an untouched step is passed through as it is
    expect(enough).toBe(true);
    expect(stepsValid(tour, replica, 4).enough).toBe(false);
    expect(stepsValid(tourOf('t', say(gone)), replica)).toEqual({ steps: [], enough: false });
  });

  it('frames the file, or the district or city it belongs to right now', () => {
    const slot = units.slotOf(unitA.slice(2));
    const district = units.cols.district[slot]!;
    const districts = replica.table('district');
    const city = districts.cols.city[districts.slotOf(district)]!;
    expect(frameTarget(say(unitA), replica)).toBe(unitA);
    expect(frameTarget(say(unitA, [], 'district'), replica)).toBe(districtRef(district));
    expect(frameTarget(say(unitA, [], 'city'), replica)).toBe(cityRef(city));
    expect(frameTarget(say(gone, [], 'city'), replica)).toBeNull();

    // the clustering changes: the same step now frames the file's new district and that district's city
    const moved = districts.ids.find((id) => id && districts.cols.city[districts.slotOf(id)] !== city)!;
    replica.apply({
      rev: replica.rev + 1, baseRev: replica.rev,
      ops: [{ op: 'assign', unitIds: [unitA.slice(2)], districtIds: [moved], units: [slot], districts: [districts.slotOf(moved)] }],
    });
    expect(frameTarget(say(unitA, [], 'district'), replica)).toBe(districtRef(moved));
    expect(frameTarget(say(unitA, [], 'city'), replica)).toBe(cityRef(districts.cols.city[districts.slotOf(moved)]!));
  });

  it('offers the latest tour annotation that still has a valid step', () => {
    expect(offeredTour(replica)).toBeNull();
    const whole = tourOf('whole', say(unitA, [], 'city'), say(unitB));
    const partial = tourOf('partial', say(gone), say(unitB));
    const annotate = (value: Tour) => replica.apply({ rev: replica.rev + 1, baseRev: replica.rev, ops: [{ op: 'annotation', value }] });
    annotate(whole);
    expect(offeredTour(replica)).toBe(whole);
    annotate(partial);
    expect(offeredTour(replica)).toEqual(tourOf('partial', say(unitB)));
    annotate(tourOf('dead', say(gone)));
    expect(offeredTour(replica)?.id).toBe('partial');
  });
});

describe('framing a territory clear of the step card', () => {
  // a camera looking straight down: one pixel is `scale` world units, the target is under the centre
  const view: Box = { left: 0, top: 0, right: 1200, bottom: 800 };
  const camera = { cameraDistance: 300, target: { x: 0, z: 0 } };
  const topDown = (scale: number) => ({ screenToGround: (x: number, y: number) => ({ x: (x - 600) * scale, z: (y - 400) * scale }) });
  const card: Box = { left: 380, top: 600, right: 820, bottom: 780 };

  it('stands back in proportion to the territory, and further when the card is in the way', () => {
    const open = clearDistance(topDown(0.5), camera, 40, view, null)!;
    expect(open).toBeGreaterThan(0);
    expect(clearDistance(topDown(0.5), camera, 80, view, null)).toBeCloseTo(open * 2, 6);
    // the same picture from a camera already twice as far away: the answer does not change
    expect(clearDistance(topDown(1), { ...camera, cameraDistance: 600 }, 40, view, null)).toBeCloseTo(open, 6);
    expect(clearDistance(topDown(0.5), camera, 40, view, card)!).toBeGreaterThan(open);
  });

  it('gives no answer when the ground cannot be found', () => {
    expect(clearDistance({ screenToGround: () => null }, camera, 40, view, card)).toBeNull();
    expect(clearDistance(topDown(0.5), camera, 0, view, card)).toBeNull();
  });
});
