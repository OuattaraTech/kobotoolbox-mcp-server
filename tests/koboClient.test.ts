import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The client reads its token at import time, so configure the environment first.
process.env.KOBO_API_TOKEN = process.env.KOBO_API_TOKEN || "test-token";
process.env.KOBO_BASE_URL = "https://kf.example.org";

const { urlTail, collectAttachments, ROLE_PERMISSIONS, buildInstanceXml, kobocatOrigin } = await import(
  "../src/services/koboClient.js"
);

describe("urlTail", () => {
  it("extracts the identifier from a hyperlinked field", () => {
    expect(urlTail("https://kf.example.org/api/v2/users/awa/")).toBe("awa");
  });

  it("ignores a trailing query string — Kobo sometimes appends ?format=json", () => {
    expect(urlTail("https://kf.example.org/api/v2/permissions/view_asset/?format=json")).toBe("view_asset");
  });
});

describe("ROLE_PERMISSIONS", () => {
  it("nests the roles, so each level includes the one below", () => {
    for (const perm of ROLE_PERMISSIONS.view) expect(ROLE_PERMISSIONS.edit).toContain(perm);
    for (const perm of ROLE_PERMISSIONS.edit) expect(ROLE_PERMISSIONS.manage).toContain(perm);
  });

  it("only grants manage_asset at the manage level", () => {
    expect(ROLE_PERMISSIONS.view).not.toContain("manage_asset");
    expect(ROLE_PERMISSIONS.edit).not.toContain("manage_asset");
    expect(ROLE_PERMISSIONS.manage).toContain("manage_asset");
  });
});

describe("collectAttachments", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    _id: 42,
    _attachments: [
      {
        uid: "att1",
        download_url: "https://kf.example.org/a/1/",
        filename: "user/attachments/abc/IMG_1039.jpeg",
        media_file_basename: "IMG_1039.jpeg",
        mimetype: "image/jpeg",
        is_deleted: false,
      },
    ],
    ...over,
  });

  it("pulls out the download url and a safe basename", () => {
    const refs = collectAttachments([row()]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      submissionId: "42",
      basename: "IMG_1039.jpeg",
      mimetype: "image/jpeg",
      downloadUrl: "https://kf.example.org/a/1/",
    });
  });

  it("skips deleted attachments and rows that have none", () => {
    expect(collectAttachments([row({ _attachments: [{ uid: "x", is_deleted: true }] })])).toEqual([]);
    expect(collectAttachments([{ _id: 1 }])).toEqual([]);
    expect(collectAttachments([{ _id: 1, _attachments: null }])).toEqual([]);
  });

  it("never lets a nested filename escape into a path", () => {
    const refs = collectAttachments([
      row({ _attachments: [{ ...row()._attachments[0], media_file_basename: "a/b/../evil.jpeg" }] }),
    ]);
    expect(refs[0].basename).toBe("evil.jpeg");
    expect(refs[0].basename).not.toContain("/");
  });
});

describe("error reporting", () => {
  let client: typeof import("../src/services/koboClient.js");
  let axios: typeof import("axios").default;

  beforeEach(async () => {
    vi.resetModules();
    axios = (await import("axios")).default;
    client = await import("../src/services/koboClient.js");
  });

  afterEach(() => vi.restoreAllMocks());

  /** Builds the axios error shape the client's handler inspects. */
  function axiosError(status: number, data: unknown) {
    const err: any = new Error(`Request failed with status code ${status}`);
    err.isAxiosError = true;
    err.response = { status, data, headers: {} };
    err.config = { method: "get" };
    return err;
  }

  it("replaces a Django HTML 500 page with the actual likely cause", async () => {
    const html = "<!doctype html><html><head><title>KoboToolbox</title></head><body>Server error (500)</body></html>";
    vi.spyOn(axios, "create").mockReturnValue({
      get: vi.fn().mockRejectedValue(axiosError(500, html)),
      interceptors: { response: { use: vi.fn() } },
    } as any);

    await expect(client.getAsset("abc")).rejects.toThrow(/phonenumber.*not.*phone_number/s);
    // The HTML body itself must not be dumped into the model's context.
    await expect(client.getAsset("abc")).rejects.not.toThrow(/doctype/i);
  });

  it("explains a 401 in terms of the token", async () => {
    vi.spyOn(axios, "create").mockReturnValue({
      get: vi.fn().mockRejectedValue(axiosError(401, { detail: "Invalid token." })),
      interceptors: { response: { use: vi.fn() } },
    } as any);

    await expect(client.getAsset("abc")).rejects.toThrow(/KOBO_API_TOKEN/);
  });

  it("names rate limiting rather than reporting a generic failure", async () => {
    vi.spyOn(axios, "create").mockReturnValue({
      get: vi.fn().mockRejectedValue(axiosError(429, { detail: "Throttled." })),
      interceptors: { response: { use: vi.fn() } },
    } as any);

    await expect(client.getAsset("abc")).rejects.toThrow(/rate-limiting/);
  });

  it("keeps a useful JSON 400 body", async () => {
    vi.spyOn(axios, "create").mockReturnValue({
      get: vi.fn().mockRejectedValue(axiosError(400, { name: ["This field is required."] })),
      interceptors: { response: { use: vi.fn() } },
    } as any);

    await expect(client.getAsset("abc")).rejects.toThrow(/This field is required/);
  });

  it("raises KoboApiError, so the tools layer can format it", async () => {
    vi.spyOn(axios, "create").mockReturnValue({
      get: vi.fn().mockRejectedValue(axiosError(404, {})),
      interceptors: { response: { use: vi.fn() } },
    } as any);

    // Compare against the freshly-imported class: vi.resetModules() gives each
    // test its own module instance, so the top-level import is a different identity.
    await expect(client.getAsset("abc")).rejects.toBeInstanceOf(client.KoboApiError);
  });
});

describe("buildInstanceXml", () => {

  it("nests answers by their submission path", () => {
    const xml = buildInstanceXml("aX", "v1", { "sec/nom": "Maquis", couverts: 40 }, "u1");
    expect(xml).toContain("<sec><nom>Maquis</nom></sec>");
    expect(xml).toContain("<couverts>40</couverts>");
  });

  it("escapes XML metacharacters so a name like 'R & B' cannot break the document", () => {
    const xml = buildInstanceXml("aX", undefined, { nom: 'Chez "R" & <B>' }, "u1");
    expect(xml).toContain("Chez &quot;R&quot; &amp; &lt;B&gt;");
  });

  it("carries the form id, version and instance id Kobo matches on", () => {
    const xml = buildInstanceXml("aXYZ", "vABC", { q: "1" }, "abc-123");
    expect(xml).toContain('<aXYZ id="aXYZ" version="vABC">');
    expect(xml).toContain("<instanceID>uuid:abc-123</instanceID>");
    expect(xml.trimEnd()).toMatch(/<\/aXYZ>$/);
  });

  it("omits the version attribute when the form has none", () => {
    // The XML declaration always carries version="1.0", so assert on the root element.
    expect(buildInstanceXml("aX", undefined, { q: "1" }, "u1")).toContain('<aX id="aX">');
  });

  it("drops empty answers rather than submitting blank nodes", () => {
    const xml = buildInstanceXml("aX", "v1", { a: "", b: null as any, c: undefined as any, d: "x" }, "u1");
    expect(xml).not.toContain("<a>");
    expect(xml).not.toContain("<b>");
    expect(xml).toContain("<d>x</d>");
  });
});

describe("kobocatOrigin", () => {

  it("reads the KoboCAT host off the asset's own download links", () => {
    expect(
      kobocatOrigin({
        deployment__data_download_links: { xls_legacy: "https://kc.example.org/u/exports/a1/xls/" },
      } as any)
    ).toBe("https://kc.example.org");
  });

  it("falls back to the hosted naming convention when the asset says nothing", () => {
    expect(kobocatOrigin(undefined)).toMatch(/^https:\/\/kc[.-]/);
  });
});
