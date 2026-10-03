import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { build, rawString } from "./command-builder";

describe("shell argument boundaries", () => {
  for (const value of [
    "",
    "中文 路径",
    "a'b\"c",
    "$(touch /tmp/genshin-unwanted)",
    "a\nb\tc",
    "x;&|<>[]*`~\\",
  ]) {
    it(`round trips ${JSON.stringify(value)}`, () => {
      expect(
        execSync(build(["/usr/bin/printf", "%s", value]), { encoding: "utf8" })
      ).toBe(value);
    });
  }
  it("quotes environment values and preserves empty values", () => {
    expect(
      execSync(
        build(["/bin/sh", "-c", 'printf "%s" "$LAUNCHER_VALUE"'], {
          LAUNCHER_VALUE: "中文 '$()`",
        }),
        { encoding: "utf8" }
      )
    ).toBe("中文 '$()`");
  });
  it("rejects environment name injection and NUL", () => {
    expect(() => build(["true"], { "x; touch /tmp/x": "x" })).toThrow();
    expect(() => build(["echo", "\0"])).toThrow();
  });
  it("supports explicit trusted pipelines", () => {
    expect(
      execSync(build(["printf", "%s", "abc", rawString("|"), "wc", "-c"]), {
        encoding: "utf8",
      }).trim()
    ).toBe("3");
  });
});
