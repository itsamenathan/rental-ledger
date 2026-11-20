import { describe, expect, it } from "vite-plus/test";
import { CAMERA_KEY, canFocus, focusAt, openCamera, type Media, type Store } from "./camera-pick.ts";

interface FakeCam {
  id: string;
  facing: "environment" | "user";
  focus?: string[];
  poi?: boolean;
}

/** A phone: cameras in the order the browser lists them; `facingMode: environment` opens `envPick`. */
function phone(cams: FakeCam[], envPick = cams.find((c) => c.facing === "environment")?.id) {
  const opened: string[] = [];
  const live = new Set<string>();
  const applied: unknown[] = [];
  const stream = (c: FakeCam) => {
    if (live.size) throw Object.assign(new Error("busy"), { name: "NotReadableError" }); // one camera at a time
    live.add(c.id);
    opened.push(c.id);
    const track = {
      label: c.facing === "user" ? "camera2 1, facing front" : "camera2 0, facing back",
      readyState: "live",
      getSettings: () => ({ deviceId: c.id, facingMode: c.facing }),
      getCapabilities: () => ({
        ...(c.focus ? { focusMode: c.focus } : {}),
        ...(c.poi ? { pointsOfInterest: {} } : {}),
      }),
      applyConstraints: async (x: unknown) => void applied.push(x),
      stop: () => live.delete(c.id),
    } as unknown as MediaStreamTrack;
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  };
  const media: Media = {
    async getUserMedia(c) {
      const v = c.video as { deviceId?: { exact: string }; facingMode?: { exact?: string; ideal?: string } };
      if (v.deviceId) {
        const cam = cams.find((x) => x.id === v.deviceId!.exact);
        if (!cam) throw Object.assign(new Error("gone"), { name: "OverconstrainedError" });
        return stream(cam);
      }
      const cam = cams.find((x) => x.id === envPick);
      if (!cam) {
        if (v.facingMode?.exact) throw Object.assign(new Error("none"), { name: "OverconstrainedError" });
        return stream(cams[0]!);
      }
      return stream(cam);
    },
    enumerateDevices: async () => cams.map((c) => ({ kind: "videoinput", deviceId: c.id })),
  };
  return { media, opened, live, applied };
}

function memory(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const AF = ["manual", "single-shot", "continuous"];
const idOf = (s: MediaStream) => s.getVideoTracks()[0]!.getSettings().deviceId;

describe("openCamera", () => {
  it("keeps the back camera that opened when it can focus, and remembers it", async () => {
    const p = phone([
      { id: "main", facing: "environment", focus: AF },
      { id: "front", facing: "user", focus: AF },
    ]);
    const store = memory();
    expect(idOf(await openCamera(p.media, store))).toBe("main");
    expect(p.opened).toEqual(["main"]);
    expect(store.data.get(CAMERA_KEY)).toBe("main");
  });

  it("moves off a fixed-focus lens (the ultra-wide) to a back camera that can focus", async () => {
    const p = phone(
      [
        { id: "wide", facing: "environment", focus: ["manual"] },
        { id: "front", facing: "user", focus: AF },
        { id: "main", facing: "environment", focus: AF },
      ],
      "wide",
    );
    const store = memory();
    const s = await openCamera(p.media, store);
    expect(idOf(s)).toBe("main");
    expect(p.opened).toEqual(["wide", "front", "main"]); // the front camera is skipped though it can focus
    expect(p.live).toEqual(new Set(["main"])); // nothing else left running
    expect(store.data.get(CAMERA_KEY)).toBe("main");

    // Next scan: straight to the remembered camera.
    s.getTracks().forEach((t) => t.stop());
    p.opened.length = 0;
    expect(idOf(await openCamera(p.media, store))).toBe("main");
    expect(p.opened).toEqual(["main"]);
  });

  it("settles for the first camera when none can focus, without searching again", async () => {
    const p = phone(
      [
        { id: "a", facing: "environment" },
        { id: "b", facing: "environment" },
      ],
      "a",
    );
    const store = memory();
    expect(idOf(await openCamera(p.media, store))).toBe("a");
    expect(store.data.get(CAMERA_KEY)).toBe("a");
    expect(p.live).toEqual(new Set(["a"]));
  });

  it("chooses again when the remembered camera is gone, and uses any camera without a back one", async () => {
    const p = phone([{ id: "webcam", facing: "user", focus: AF }], undefined);
    const store = memory();
    store.setItem(CAMERA_KEY, "old-phone-camera");
    expect(idOf(await openCamera(p.media, store))).toBe("webcam");
    expect(store.data.get(CAMERA_KEY)).toBe("webcam");
  });
});

describe("focus", () => {
  it("treats browsers without capabilities as able to focus", () => {
    expect(canFocus({} as MediaStreamTrack)).toBe(true);
  });

  it("taps to focus at a point, and says when the camera can't", async () => {
    const p = phone([{ id: "main", facing: "environment", focus: AF, poi: true }]);
    const s = await openCamera(p.media, null);
    expect(focusAt(s.getVideoTracks()[0], 0.25, 0.5)).toBe(true);
    await Promise.resolve();
    expect(p.applied).toContainEqual({
      advanced: [{ pointsOfInterest: [{ x: 0.25, y: 0.5 }], focusMode: "single-shot" }],
    });

    const fixed = phone([{ id: "f", facing: "environment", focus: ["manual"] }]);
    expect(focusAt((await openCamera(fixed.media, null)).getVideoTracks()[0], 0.5, 0.5)).toBe(false);
  });
});
