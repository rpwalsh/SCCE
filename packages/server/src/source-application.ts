// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  SourceLearningApplication as SharedSourceLearningApplication,
  type LearnSourceCommand,
  type LearnSourceResult,
  type ScceStorage,
  type SourceVersion,
  type SourceVersionId
} from "@scce/kernel";
import { ApplicationError } from "./turn-application.js";

export interface SourceVersionSummary extends SourceVersion {
  readonly maxAlpha: number;
  readonly promotedSpanCount: number;
}

export interface SourceVersionPage {
  readonly items: readonly SourceVersionSummary[];
  readonly hasNextPage: boolean;
}

/**
 * Read-only source application boundary shared by every local transport.
 * Corpus paging and exact identity lookup stay separate: listing never
 * substitutes ranked search for an exact SourceVersion refetch.
 */
export class SourceApplication {
  readonly #storage: ScceStorage;
  readonly #learning?: SharedSourceLearningApplication;

  constructor(storage: ScceStorage, learning?: SharedSourceLearningApplication) {
    this.#storage = storage;
    this.#learning = learning;
  }

  learn(input: LearnSourceCommand): Promise<LearnSourceResult> {
    if (!this.#learning) throw new ApplicationError("UNAVAILABLE", "source learning is unavailable in this runtime");
    return this.#learning.learn(input);
  }

  async get(sourceVersionId: string): Promise<SourceVersion | null> {
    if (!this.#storage.evidence.sourceVersionById) {
      throw new ApplicationError("UNAVAILABLE", "exact source-version lookup is unavailable in this storage adapter");
    }
    return this.#storage.evidence.sourceVersionById(sourceVersionId as SourceVersionId);
  }

  async page(input: { first: number; afterSourceVersionId?: string }): Promise<SourceVersionPage> {
    if (!Number.isInteger(input.first) || input.first < 1 || input.first > 50) {
      throw new ApplicationError("RESOURCE_LIMIT", "source page size must be between 1 and 50");
    }
    const list = this.#storage.evidence.listEvidenceBackedSourceVersions;
    if (!list || !this.#storage.evidence.sourceVersionById) {
      throw new ApplicationError("UNAVAILABLE", "paged source inventory is unavailable in this storage adapter");
    }
    const inventory = await list({
      limit: input.first + 1,
      orderBySourceVersionId: true,
      excludeTrainingDerived: true,
      ...(input.afterSourceVersionId ? { afterSourceVersionId: input.afterSourceVersionId } : {})
    });
    const selected = inventory.slice(0, input.first);
    const versions = await Promise.all(selected.map(row => this.get(String(row.sourceVersionId))));
    const items = selected.flatMap((row, index) => {
      const version = versions[index];
      return version ? [{ ...version, maxAlpha: row.maxAlpha, promotedSpanCount: row.promotedSpanCount }] : [];
    });
    return { items, hasNextPage: inventory.length > input.first };
  }
}
