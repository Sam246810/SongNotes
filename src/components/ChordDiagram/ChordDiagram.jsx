import { CHORD_DB } from '../../utils/chords';
import styles from './ChordDiagram.module.css';

// SVG layout constants
const W = 110;
const H = 155;
const LEFT = 15;    // x of first string (lowE)
const RIGHT = 95;   // x of last string (highE)
const STR_GAP = (RIGHT - LEFT) / 5; // spacing between strings = 16
const NUT_Y = 28;   // y of the nut / top fret line
const FRET_GAP = 26; // vertical spacing between fret lines
const FRETS_SHOWN = 4;
const MARKER_Y = 14; // y of X/O/fret-number markers above nut
const DOT_R = 7;    // finger dot radius
const BARRE_R = 7;  // barre chord bar radius

// Fret line y positions (5 lines = 4 rows)
const fretY = Array.from({ length: FRETS_SHOWN + 1 }, (_, i) => NUT_Y + i * FRET_GAP);
// Dot center y positions for each fret row (1-indexed)
const dotY = (row) => fretY[row - 1] + FRET_GAP / 2;
// String x positions (0=lowE, 5=highE)
const strX = (s) => LEFT + s * STR_GAP;

const COLORS = {
  dot: '#a78bfa',
  barre: '#a78bfa',
  open: '#6ee7b7',
  muted: '#f87171',
  nut: '#e8eaf6',
  fret: '#353d57',
  string: '#353d57',
  label: '#8892b0',
  fretNum: '#e8eaf6',
};

export default function ChordDiagram({ chordName }) {
  const data = CHORD_DB[chordName];

  if (!data) {
    return (
      <div className={styles.popup}>
        <div className={styles.chordName}>{chordName}</div>
        <div className={styles.noChart}>no chord chart for this chord yet &gt;.&lt;</div>
      </div>
    );
  }

  const { frets, baseFret = 1, barre } = data;

  // Convert absolute fret to display row (1–4), or 0/−1 as-is
  const toRow = (f) => (f <= 0 ? f : f - baseFret + 1);

  return (
    <div className={styles.popup}>
      <div className={styles.chordName}>{chordName}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        aria-label={`${chordName} chord diagram`}
        className={styles.svg}
      >
        {/* === Strings === */}
        {[0,1,2,3,4,5].map((s) => (
          <line
            key={`str-${s}`}
            x1={strX(s)} y1={NUT_Y}
            x2={strX(s)} y2={fretY[FRETS_SHOWN]}
            stroke={COLORS.string} strokeWidth={1.5}
          />
        ))}

        {/* === Fret lines === */}
        {fretY.map((y, i) => (
          <line
            key={`fret-${i}`}
            x1={LEFT} y1={y} x2={RIGHT} y2={y}
            stroke={i === 0 && baseFret === 1 ? COLORS.nut : COLORS.fret}
            strokeWidth={i === 0 && baseFret === 1 ? 3 : 1.5}
          />
        ))}

        {/* === Barre === */}
        {barre && (() => {
          const row = toRow(barre.fret);
          if (row < 1 || row > FRETS_SHOWN) return null;
          const x1 = strX(barre.fromString);
          const x2 = strX(barre.toString);
          const cy = dotY(row);
          return (
            <rect
              key="barre"
              x={x1} y={cy - BARRE_R}
              width={x2 - x1} height={BARRE_R * 2}
              rx={BARRE_R} ry={BARRE_R}
              fill={COLORS.barre}
            />
          );
        })()}

        {/* === Finger dots === */}
        {frets.map((f, s) => {
          const row = toRow(f);
          if (f <= 0 || row < 1 || row > FRETS_SHOWN) return null;
          // Skip barre positions (the barre rect already covers them)
          if (barre && row === toRow(barre.fret) && s >= barre.fromString && s <= barre.toString) return null;
          return (
            <circle
              key={`dot-${s}`}
              cx={strX(s)} cy={dotY(row)}
              r={DOT_R}
              fill={COLORS.dot}
            />
          );
        })}

        {/* === X / O markers above nut === */}
        {frets.map((f, s) => {
          if (f === 0) {
            return (
              <text
                key={`open-${s}`}
                x={strX(s)} y={MARKER_Y}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={11} fontWeight="600"
                fill={COLORS.open}
              >O</text>
            );
          }
          if (f === -1) {
            return (
              <text
                key={`muted-${s}`}
                x={strX(s)} y={MARKER_Y}
                textAnchor="middle" dominantBaseline="middle"
                fontSize={11} fontWeight="700"
                fill={COLORS.muted}
              >✕</text>
            );
          }
          return null;
        })}

        {/* === Fret number label (if not starting at 1) === */}
        {baseFret > 1 && (
          <text
            x={RIGHT + 8} y={dotY(1)}
            textAnchor="start" dominantBaseline="middle"
            fontSize={10} fontWeight="600"
            fill={COLORS.fretNum}
          >
            {baseFret}fr
          </text>
        )}

        {/* === String names at bottom === */}
        {['E','A','D','G','B','e'].map((name, s) => (
          <text
            key={`sname-${s}`}
            x={strX(s)} y={H - 4}
            textAnchor="middle" dominantBaseline="auto"
            fontSize={9}
            fill={COLORS.label}
          >{name}</text>
        ))}
      </svg>
    </div>
  );
}
