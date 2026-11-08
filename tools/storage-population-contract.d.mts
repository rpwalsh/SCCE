// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export interface StoragePopulationMeasurement { sampledRows: number; cap: number | null; exact: boolean; capReached: boolean }
export function storagePopulationMeasurement(status: unknown, table: string): StoragePopulationMeasurement | undefined;
