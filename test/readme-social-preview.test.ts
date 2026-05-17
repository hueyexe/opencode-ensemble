import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const readmePath = join(root, "README.md");
const previewPath = join(root, "social-preview.png");
const gitignorePath = join(root, ".gitignore");
const packagePath = join(root, "package.json");

describe("README social preview", () => {
  test("references the generated social preview before the title", () => {
    const readme = readFileSync(readmePath, "utf8");
    const imageBlock = `<p align="center">
  <img src="social-preview.png" alt="OpenCode Ensemble - Parallel agents. One coordinated team." width="100%">
</p>`;

    expect(readme.indexOf(imageBlock)).toBeGreaterThanOrEqual(0);
    expect(readme.indexOf(imageBlock)).toBeLessThan(readme.indexOf("# OpenCode Ensemble"));
  });

  test("includes the generated social preview image", () => {
    expect(existsSync(previewPath)).toBe(true);
  });

  test("publishes the generated social preview image", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { files?: string[] };

    expect(packageJson.files).toContain("social-preview.png");
  });

  test("ignores local superpowers artifacts and docs", () => {
    const gitignore = readFileSync(gitignorePath, "utf8");

    expect(gitignore).toContain(".superpowers/");
    expect(gitignore).toContain("dogfood-output/");
    expect(gitignore).toContain("docs/superpowers/");
  });

  test("uses the bumped plugin version in install snippets", () => {
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain("@hueyexe/opencode-ensemble@0.14.2");
    expect(readme).not.toContain("@hueyexe/opencode-ensemble@0.14.0");
  });
});
