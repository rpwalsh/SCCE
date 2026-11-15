// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { commitMutation, type Environment, type MutationParameters } from "relay-runtime";
export function command<T extends MutationParameters>(environment: Environment, mutation: Parameters<typeof commitMutation<T>>[1]["mutation"], variables: T["variables"]): Promise<T["response"]> {
  return new Promise((resolve, reject) => commitMutation<T>(environment, { mutation, variables,
    onCompleted(data, errors) { if (errors?.length) reject(new Error(errors.map(error => error.message).join("; "))); else resolve(data); }, onError: reject }));
}
