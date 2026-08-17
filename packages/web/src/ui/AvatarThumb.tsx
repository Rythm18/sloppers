/**
 * The standing-facing-camera frame of a character sheet, cropped via an
 * overflow window so it stays crisp at 2× pixel scale.
 */
export function AvatarThumb({ avatar, scale = 2 }: { avatar: string; scale?: number }) {
  return (
    <span
      className="avatar-thumb"
      style={{ width: 16 * scale, height: 20 * scale }}
      aria-hidden="true"
    >
      <img
        src={`/assets/char-${avatar}.png`}
        alt=""
        style={{ width: 64 * scale, height: 80 * scale }}
        draggable={false}
      />
    </span>
  );
}
