// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Environment } from "relay-runtime";
import reserveMutation, { type WorkbenchReserveMutation } from "./__generated__/WorkbenchReserveMutation.graphql";
import startMutation, { type WorkbenchStartMutation } from "./__generated__/WorkbenchStartMutation.graphql";
import approveMutation, { type WorkbenchApprovePlanMutation } from "./__generated__/WorkbenchApprovePlanMutation.graphql";
import rejectMutation, { type WorkbenchRejectPlanMutation } from "./__generated__/WorkbenchRejectPlanMutation.graphql";
import cancelMutation, { type WorkbenchCancelMutation } from "./__generated__/WorkbenchCancelMutation.graphql";
import { WorkbenchTurnController } from "./turn-controller";
import { command } from "./relay-command";

export function createRelayTurnController(environment: Environment, store: Pick<Storage, "getItem" | "setItem">, scope: string) {
  return new WorkbenchTurnController({
    async reserve() { return (await command<WorkbenchReserveMutation>(environment, reserveMutation, { input: {} })).reserveTurn.task.id; },
    async start(input) { await command<WorkbenchStartMutation>(environment, startMutation, { input }); },
    async approve(input) { return (await command<WorkbenchApprovePlanMutation>(environment, approveMutation, { input })).vscodeApprovePlan.approved; },
    async reject(input) { return (await command<WorkbenchRejectPlanMutation>(environment, rejectMutation, { input })).vscodeRejectPlan.rejected; },
    async cancel(taskId) { await command<WorkbenchCancelMutation>(environment, cancelMutation, { input: { taskId } }); }
  }, store, scope);
}
