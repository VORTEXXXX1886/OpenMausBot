import { describe, expect, it } from "vitest";

import type { ProviderAdapter, RuntimeEvent, RuntimeEventListener } from "../contracts.ts";
import { recordEvents } from "./events.ts";

function fakeAdapter() {
  const listeners = new Set<RuntimeEventListener>();
  const adapter = {
    onEvent(listener: RuntimeEventListener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as ProviderAdapter;

  return {
    adapter,
    emit(event: RuntimeEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const event = (type: string): RuntimeEvent => ({ type } as unknown as RuntimeEvent);

describe("recordEvents", () => {
  it("records events in arrival order and resolves for an event emitted before until()", async () => {
    const source = fakeAdapter();
    const recorder = recordEvents(source.adapter);
    const first = event("first");
    const second = event("second");

    source.emit(first);
    source.emit(second);

    expect(recorder.events).toEqual([first, second]);
    expect(await recorder.until((item) => item.type === "first")).toBe(first);
    recorder.stop();
  });

  it("resolves independent pending waiters only when their predicates match", async () => {
    const source = fakeAdapter();
    const recorder = recordEvents(source.adapter);
    const firstWaiter = recorder.until((item) => item.type === "first");
    const secondWaiter = recorder.until((item) => item.type === "second");
    const first = event("first");
    const second = event("second");

    source.emit(second);
    source.emit(first);

    expect(await firstWaiter).toBe(first);
    expect(await secondWaiter).toBe(second);
    expect(recorder.events).toEqual([second, first]);
    recorder.stop();
  });

  it("resolves every matching waiter from the same event", async () => {
    const source = fakeAdapter();
    const recorder = recordEvents(source.adapter);
    const firstWaiter = recorder.until((item) => item.type === "shared");
    const secondWaiter = recorder.until((item) => item.type === "shared");
    const shared = event("shared");

    source.emit(shared);

    expect(await firstWaiter).toBe(shared);
    expect(await secondWaiter).toBe(shared);
    recorder.stop();
  });

  it("unsubscribes on stop so later events are not recorded", () => {
    const source = fakeAdapter();
    const recorder = recordEvents(source.adapter);
    expect(source.listenerCount()).toBe(1);
    source.emit(event("before"));

    recorder.stop();

    expect(source.listenerCount()).toBe(0);
    source.emit(event("after"));
    expect(recorder.events.map((item) => item.type)).toEqual(["before"]);
  });
});
