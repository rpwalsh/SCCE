import { describe, expect, it } from "vitest";
import {
  bayesUpdate,
  boltzmannDistribution,
  conductanceEquation,
  freeEnergyObjective,
  heatDiffuse,
  kalmanUpdate,
  kirchhoffBalance,
  leastActionPath,
  maxFlowMinCut,
  proofPathSemiring,
  regularizedCalibrationLoss,
  replicatorDynamicsStep,
  settlePottsConsistency,
  shannonEntropy,
  spectralPartition,
  wavePropagate
} from "../equation-operators.js";

describe("equation operators", () => {
  it("computes extraction confidence equations", () => {
    const bayes = bayesUpdate({ prior: 0.4, likelihood: 0.9, alternativeLikelihood: 0.2 });
    expect(bayes.posterior).toBeGreaterThan(0.7);
    const entropy = shannonEntropy([0.5, 0.5, 0]);
    expect(entropy.normalized).toBeGreaterThan(0.5);
    expect(entropy.support).toBe(2);
  });

  it("computes graph conductance and field motion", () => {
    expect(conductanceEquation({ weight: 0.8, alpha: 0.9, provenance: 0.75, temporalFit: 1, modalityAgreement: 1, contradictionPenalty: 0.2 })).toBeGreaterThan(0.4);
    const laplacian = [
      [1, -1, 0],
      [-1, 2, -1],
      [0, -1, 1]
    ];
    const heat = heatDiffuse({ laplacian, current: [1, 0, 0], steps: 4 });
    const wave = wavePropagate({ laplacian, current: heat.values, previous: [1, 0, 0], steps: 2 });
    const spectral = spectralPartition({ nodes: ["a", "b", "c"], laplacian, iterations: 12 });
    expect(heat.values[1]).toBeGreaterThan(0);
    expect(heat.values.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    expect(heat.massDrift).toBeCloseTo(0, 12);
    expect(wave.momentum).toBeGreaterThanOrEqual(0);
    expect(wave.values.every(Number.isFinite)).toBe(true);
    expect(spectral.clusters.length).toBeGreaterThan(0);
    expect(spectral.algebraicConnectivity).toBeCloseTo(1, 8);
    expect(spectral.partitionEigengap).toBeCloseTo(2, 8);
    expect(spectral.residual).toBeLessThan(1e-8);
    expect(spectral.converged).toBe(true);
  });

  it("rejects unstable diffusion parameters instead of silently clipping state", () => {
    const laplacian = [
      [1, -1],
      [-1, 1]
    ];
    expect(() => heatDiffuse({ laplacian, current: [1, 0], eta: 1.1 })).toThrow(/heat step/);
    expect(() => wavePropagate({ laplacian, current: [1, 0], speed: 2 })).toThrow(/wave speed/);
    const signedWave = wavePropagate({ laplacian, current: [0, 1], previous: [1, 0], steps: 1 });
    expect(signedWave.values[0]).toBeLessThan(0);
  });

  it("computes proof conservation and consistency operators", () => {
    const semiring = proofPathSemiring({ paths: [{ conductances: [0.9, 0.8], risks: [0.1, 0.2] }, { conductances: [0.4], contradiction: 0.2 }] });
    expect(semiring.maxProductSupport).toBeGreaterThan(0.7);
    const flow = maxFlowMinCut({
      nodes: ["s", "a", "t"],
      edges: [{ source: "s", target: "a", capacity: 0.8 }, { source: "a", target: "t", capacity: 0.6 }],
      source: "s",
      sink: "t"
    });
    expect(flow.maxFlow).toBeCloseTo(0.6, 5);
    expect(flow.cutCapacity).toBeCloseTo(flow.maxFlow, 12);
    expect(flow.normalizedFlowRatio).toBeCloseTo(0.75, 12);
    const unbounded = maxFlowMinCut({
      nodes: ["s", "a", "b", "t"],
      edges: [
        { source: "s", target: "a", capacity: 2 },
        { source: "s", target: "b", capacity: 3 },
        { source: "a", target: "t", capacity: 2 },
        { source: "b", target: "t", capacity: 3 }
      ],
      source: "s",
      sink: "t"
    });
    expect(unbounded.maxFlow).toBe(5);
    expect(unbounded.cutCapacity).toBe(5);
    expect(unbounded.normalizedFlowRatio).toBe(1);
    const balance = kirchhoffBalance({ nodes: ["a", "b"], flows: [{ source: "a", target: "b", amount: 0.5 }] });
    expect(balance.totalImbalance).toBeGreaterThan(0);
    const potts = settlePottsConsistency({ nodes: ["x", "y"], edges: [{ source: "x", target: "y", coupling: 0.9, oppose: true }], iterations: 6 });
    expect(potts.contradictionPressure).toBeLessThan(1);
  });

  it("computes candidate and learning equations", () => {
    const path = leastActionPath({
      nodes: ["q", "a", "b"],
      edges: [{ source: "q", target: "a", cost: 0.6 }, { source: "q", target: "b", cost: 0.2 }],
      source: "q",
      target: "b"
    });
    expect(path.reachable).toBe(true);
    expect(path.cost).toBeCloseTo(0.2, 5);
    const energy = freeEnergyObjective({ error: 0.2, complexity: 0.4, utility: 0.8 });
    expect(energy).toBeLessThan(0.4);
    const probabilities = boltzmannDistribution({ energies: [0.1, 0.9], temperature: 0.2 });
    expect(probabilities[0]).toBeGreaterThan(probabilities[1] ?? 0);
    const kalman = kalmanUpdate({ estimate: 0.2, estimateVariance: 0.1, measurement: 0.9, measurementVariance: 0.1 });
    expect(kalman.estimate).toBeGreaterThan(0.2);
    const replicated = replicatorDynamicsStep({ weights: [0.5, 0.5], fitness: [1.4, 0.8] });
    expect(replicated[0]).toBeGreaterThan(replicated[1] ?? 0);
    expect(regularizedCalibrationLoss({ predictions: [0.9, 0.1], outcomes: [true, false] })).toBeLessThan(0.2);
  });
});
