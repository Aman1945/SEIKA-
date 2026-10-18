"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera scanner for the code on the PC screen.
 *
 * The PC's QR holds a link to this app with the session token on it, so this
 * accepts either form: a full URL (take ?t=) or a bare token, because a kiosk
 * that has no playerUrl configured still encodes the raw token.
 *
 * Decoding prefers the browser's own BarcodeDetector, which is hardware
 * accelerated where it exists (Chrome, Android). Safari and iOS do not have
 * it, so jsQR reads the frames there instead — slower, but it is the
 * difference between working on an iPhone and not.
 */

type Props = {
  onToken: (token: string) => void;
  onClose: () => void;
};

/** Pulls the token out of whatever the QR actually contained. */
function extractToken(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const t = url.searchParams.get("t");
    if (t) return t;
  } catch {
    // Not a URL — a bare token, which is what an unconfigured kiosk encodes.
  }
  // A JWT is three dot-separated segments. Anything else is some other QR —
  // a wifi code, a UPI string — and saying so beats a confusing server error.
  return text.split(".").length === 3 ? text : null;
}

export function QrScanner({ onToken, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState("Point the camera at the code on the PC screen");

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      // getUserMedia only exists on a secure origin. Over plain HTTP the API
      // is simply absent, and without saying why the scanner just looks broken.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError(
          "The camera needs a secure (https) connection. This page is served over plain http, so the browser will not allow it. Paste the code instead, or ask for the site to be served over https."
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true"); // iOS plays inline, not fullscreen
        await video.play();
        void scan();
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission was declined. Allow it in your browser settings, or paste the code instead."
            : name === "NotFoundError"
              ? "No camera on this device. Paste the code instead."
              : `Could not start the camera: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    async function scan() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || doneRef.current) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx && w && h) {
          ctx.drawImage(video, 0, 0, w, h);

          let found: string | null = null;

          const Detector = (window as unknown as {
            BarcodeDetector?: new (o: { formats: string[] }) => {
              detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]>;
            };
          }).BarcodeDetector;

          if (Detector) {
            try {
              const codes = await new Detector({ formats: ["qr_code"] }).detect(canvas);
              found = codes[0]?.rawValue ?? null;
            } catch {
              // Fall through to jsQR rather than giving up on this frame.
            }
          }

          if (!found) {
            const image = ctx.getImageData(0, 0, w, h);
            found = jsQR(image.data, w, h, { inversionAttempts: "dontInvert" })?.data ?? null;
          }

          if (found) {
            const token = extractToken(found);
            if (token) {
              doneRef.current = true;
              setHint("Got it — attaching…");
              stop();
              onToken(token);
              return;
            }
            setHint("That is a code, but not a SEIKA one. Try the code on the PC screen.");
          }
        }
      }
      rafRef.current = requestAnimationFrame(() => void scan());
    }

    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onToken, stop]);

  return (
    <div className="scanner">
      {error ? (
        <div className="scanner__error">
          <p>{error}</p>
          <button className="btn" onClick={onClose}>
            Enter the code instead
          </button>
        </div>
      ) : (
        <>
          <div className="scanner__frame">
            <video ref={videoRef} muted playsInline className="scanner__video" />
            <div className="scanner__reticle" aria-hidden="true" />
          </div>
          <p className="scanner__hint">{hint}</p>
          <button className="btn btn--ghost" onClick={() => { stop(); onClose(); }}>
            Cancel
          </button>
        </>
      )}
      <canvas ref={canvasRef} className="scanner__canvas" />
    </div>
  );
}
