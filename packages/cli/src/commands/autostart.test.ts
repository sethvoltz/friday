// `friday disable` / `friday enable` wire to launchd: disable boots the job out
// AND removes the plist (so reboot won't auto-launch); enable re-writes the
// plist WITHOUT bootstrapping (autostart armed, not started now). Mock the
// launchd seam and assert the calls — the whole point is which launchctl/plist
// operations each command performs.

import { describe, expect, it, vi, beforeEach } from "vitest";

const bootout = vi.fn();
const removePlist = vi.fn();
const writePlist = vi.fn();
const plistExists = vi.fn(() => true);

vi.mock("../lib/launchd.js", () => ({ bootout, removePlist, writePlist, plistExists }));
vi.mock("../lib/install-paths.js", () => ({ currentLink: () => "/fake/current" }));

const { disableCommand, enableCommand } = await import("./autostart.js");

beforeEach(() => {
  bootout.mockClear();
  removePlist.mockClear();
  writePlist.mockClear();
  plistExists.mockReturnValue(true);
});

describe("friday disable", () => {
  it("boots the job out AND removes the plist (no auto-launch on reboot), never writes one", async () => {
    await (disableCommand.run as (c: unknown) => Promise<void>)({});
    expect(bootout).toHaveBeenCalledTimes(1);
    expect(removePlist).toHaveBeenCalledTimes(1);
    expect(writePlist).not.toHaveBeenCalled();
  });

  it("is idempotent when already disabled (no plist): still boots out + removePlist, no throw", async () => {
    plistExists.mockReturnValue(false);
    await expect(
      (disableCommand.run as (c: unknown) => Promise<void>)({}),
    ).resolves.toBeUndefined();
    expect(bootout).toHaveBeenCalledTimes(1);
    expect(removePlist).toHaveBeenCalledTimes(1); // rmSync force → no-op on absent file
    expect(writePlist).not.toHaveBeenCalled();
  });
});

describe("friday enable", () => {
  it("re-writes the plist for the current install but does NOT bootout or remove it", async () => {
    await (enableCommand.run as (c: unknown) => Promise<void>)({});
    expect(writePlist).toHaveBeenCalledTimes(1);
    expect(writePlist).toHaveBeenCalledWith("/fake/current");
    expect(bootout).not.toHaveBeenCalled();
    expect(removePlist).not.toHaveBeenCalled();
  });

  it("exits non-zero when the plist can't be written (e.g. fnm/brew missing)", async () => {
    writePlist.mockImplementationOnce(() => {
      throw new Error("cannot locate fnm");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("exit");
    }) as never);
    await expect((enableCommand.run as (c: unknown) => Promise<void>)({})).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
