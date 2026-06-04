import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileBytesMock = vi.fn();
vi.mock("../lib/ipc", () => ({
  readFileBytes: (path: string) => readFileBytesMock(path),
}));

import { ImageViewer } from "./ImageViewer";

const createObjectURLMock = vi.fn();
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
  readFileBytesMock.mockReset();
  createObjectURLMock.mockReset();
  revokeObjectURLMock.mockReset();
  createObjectURLMock.mockReturnValue("blob:lyceum-image");
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURLMock,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURLMock,
  });
});

describe("ImageViewer", () => {
  it("loads image bytes into a typed Blob URL and revokes it on unmount", async () => {
    readFileBytesMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
    const { unmount } = render(<ImageViewer path="/w/photo.JPG" />);

    expect(screen.getByText("Loading image…")).toBeInTheDocument();
    const img = await screen.findByRole("img", { name: "photo.JPG" });

    expect(img).toHaveAttribute("src", "blob:lyceum-image");
    expect(readFileBytesMock).toHaveBeenCalledWith("/w/photo.JPG");
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    const blob = createObjectURLMock.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/jpeg");

    unmount();
    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:lyceum-image");
  });

  it("revokes the previous Blob URL when the path changes", async () => {
    createObjectURLMock
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    readFileBytesMock.mockResolvedValue(new Uint8Array([1]));

    const { rerender } = render(<ImageViewer path="/w/a.png" />);
    await screen.findByRole("img", { name: "a.png" });

    rerender(<ImageViewer path="/w/b.webp" />);
    await screen.findByRole("img", { name: "b.webp" });

    expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:first");
  });

  it("shows load errors", async () => {
    readFileBytesMock.mockRejectedValue(new Error("missing file"));

    render(<ImageViewer path="/w/missing.png" />);

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load image: missing file"),
      ).toBeInTheDocument();
    });
  });
});
