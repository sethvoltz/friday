import { describe, it, expect } from "vitest";
import { isInterruptSignal } from "./helpers.js";

describe("isInterruptSignal", () => {
  describe("triggers (should return true)", () => {
    it.each([
      ["stop"],
      ["Stop"],
      ["STOP"],
      ["stop!"],
      ["stop."],
      ["no don't"],
      ["no don't do that"],
      ["no, don't"],
      ["No Don't"],
      ["shoot stop"],
      ["Shoot stop, wait"],
      ["cancel"],
      ["cancel that"],
      ["Cancel that please"],
      ["abort"],
      ["abort that"],
      ["revert"],
      ["revert that"],
      ["undo"],
      ["undo that"],
      ["no"],
      ["wait no"],
      ["never mind"],
      ["Never mind"],
      ["forget that"],
      ["actually stop"],
      ["actually cancel"],
      ["actually don't"],
      ["! do this instead"],
      ["!nevermind"],
    ])('"%s" → interrupt', (text) => {
      expect(isInterruptSignal(text)).toBe(true);
    });
  });

  describe("does not trigger (should return false)", () => {
    it.each([
      ["stop by"],
      ["stop by the store"],
      ["stop at"],
      ["stop for"],
      ["stop in"],
      ["stop to"],
      ["stop over"],
      ["stop it"],
      ["non-stop"],
      ["unstoppable"],
      ["I won't stop working"],
      ["please don't stop"],
      ["let's not stop"],
      ["nobody"],
      ["no problem"],
      ["no worries"],
      ["nothing to do"],
      ["normal message"],
      [""],
      ["   "],
      ["can you help me with this?"],
      ["what's the status?"],
      ["cancel order"],
      ["cancel the deploy"],
      ["cancel meeting"],
      ["abort mission"],
      ["revert merge"],
      ["revert the last commit"],
      ["undo last commit"],
      ["undo the change"],
    ])('"%s" → not interrupt', (text) => {
      expect(isInterruptSignal(text)).toBe(false);
    });
  });
});
