import { describe, expect, it } from "vitest";
import type { Project } from "@paperclipai/plugin-sdk";
import { projectForRepository, repoNameFromUrl, repositoryFor, repositoryOf, withRepositoryTag } from "../src/projects/index.js";

const project = (id: string, name: string, repoUrls: string[], primary?: string, archivedAt: Date | null = null) =>
  ({
    id,
    name,
    archivedAt,
    workspaces: repoUrls.map((repoUrl, i) => ({ id: `${id}-w${i}`, repoUrl, isPrimary: repoUrl === primary })),
    primaryWorkspace: primary ? { repoUrl: primary } : null,
  }) as unknown as Project;

describe("Paperclip project per repository (A12)", () => {
  it("reads and replaces the repo tag", () => {
    expect(repositoryOf("agent:Oak; repo:Products")).toBe("Products");
    expect(repositoryOf("agent:Oak")).toBeNull();
    expect(repositoryOf(undefined)).toBeNull();
    expect(withRepositoryTag("agent:Oak; repo:Old", "Products")).toBe("agent:Oak; repo:Products");
    expect(withRepositoryTag(null, "My;Repo")).toBe("repo:My Repo");
  });

  it("takes the repository name from ADO, GitHub and plain URLs", () => {
    expect(repoNameFromUrl("https://dev.azure.com/Org/Quetz/_git/Products")).toBe("products");
    expect(repoNameFromUrl("https://Org@dev.azure.com/Org/Quetz/_git/My%20Repo/")).toBe("my repo");
    expect(repoNameFromUrl("git@github.com:org/Grimoire.git")).toBe("grimoire");
    expect(repoNameFromUrl(null)).toBeNull();
  });

  it("prefers a project with a workspace on the repository, its primary first, then a project named like it", () => {
    const projects = [
      project("p-name", "Products", []),
      project("p-side", "Tools", ["https://dev.azure.com/O/Q/_git/Products"]),
      project("p-main", "Products service", ["https://dev.azure.com/O/Q/_git/Other", "https://dev.azure.com/O/Q/_git/Products"], "https://dev.azure.com/O/Q/_git/Products"),
      project("p-old", "Old", ["https://dev.azure.com/O/Q/_git/Grimoire"], undefined, new Date()),
    ];
    expect(projectForRepository(projects, "products")?.id).toBe("p-main");
    expect(projectForRepository([projects[0]!, projects[1]!], "Products")?.id).toBe("p-side");
    expect(projectForRepository([projects[0]!], "PRODUCTS")?.id).toBe("p-name");
    expect(projectForRepository(projects, "Grimoire")).toBeNull(); // only an archived project has it
  });

  it("finds the repository on the item or the nearest item above it", async () => {
    const items: Record<number, { id: number; rev: number; url: string; fields: Record<string, unknown> }> = {
      1: { id: 1, rev: 1, url: "", fields: { "System.Tags": "repo:Products" } },
      2: { id: 2, rev: 1, url: "", fields: { "System.Parent": 1 } },
      3: { id: 3, rev: 1, url: "", fields: { "System.Parent": 2 } },
      4: { id: 4, rev: 1, url: "", fields: { "System.Parent": 3, "System.Tags": "repo:Grimoire" } },
      9: { id: 9, rev: 1, url: "", fields: {} },
    };
    const ado = { getWorkItem: async (id: number) => items[id] as never };
    expect(await repositoryFor(ado, items[3] as never)).toEqual({ repository: "Products", fromId: 1 });
    expect(await repositoryFor(ado, items[4] as never)).toEqual({ repository: "Grimoire", fromId: 4 });
    expect(await repositoryFor(ado, items[9] as never)).toBeNull();
  });
});
