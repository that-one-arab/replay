import { motion } from "framer-motion";
import { Cpu } from "./icons";

/** An animated "Terra Core" — concentric rotating rings around a glowing core. */
export function TerraCore() {
  return (
    <div className="relative grid h-[20rem] w-[20rem] place-items-center sm:h-[24rem] sm:w-[24rem]">
      {/* Outer ambient glow */}
      <div className="absolute inset-0 rounded-full bg-emerald-500/20 blur-[90px] animate-glow" />

      {/* Concentric rings */}
      <Ring size="100%" duration={26} reverse={false} nodes={1} />
      <Ring size="76%" duration={18} reverse nodes={2} />
      <Ring size="54%" duration={12} reverse={false} nodes={1} />

      {/* Core */}
      <motion.div
        animate={{ scale: [1, 1.06, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        className="relative grid h-32 w-32 place-items-center rounded-full border border-emerald-300/30 bg-[radial-gradient(circle_at_30%_25%,#6ee7b7,#22d3ee_45%,#0e7490_85%)] shadow-[0_0_70px_-6px_var(--color-emerald-glow)]"
      >
        <div className="absolute inset-2 rounded-full border border-white/20" />
        <div className="absolute inset-5 rounded-full border border-white/10" />
        <Cpu className="h-12 w-12 text-ink-950" />
      </motion.div>

      {/* Orbiting particles */}
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="absolute left-1/2 top-1/2 h-2.5 w-2.5 rounded-full bg-emerald-200 shadow-[0_0_12px_3px_var(--color-emerald-glow)]"
          style={
            {
              "--orbit-r": `${5.5 + i * 1.6}rem`,
              marginLeft: "-5px",
              marginTop: "-5px",
              animation: `orbit ${8 + i * 2.5}s linear infinite`,
              animationDelay: `${i * -2}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function Ring({
  size,
  duration,
  reverse,
  nodes,
}: {
  size: string;
  duration: number;
  reverse: boolean;
  nodes: number;
}) {
  return (
    <motion.div
      className="absolute rounded-full border border-emerald-300/15"
      style={{ width: size, height: size }}
      animate={{ rotate: reverse ? -360 : 360 }}
      transition={{ duration, repeat: Infinity, ease: "linear" }}
    >
      {Array.from({ length: nodes }).map((_, i) => (
        <span
          key={i}
          className="absolute h-2 w-2 rounded-full bg-cyan-300/80 shadow-[0_0_10px_2px_var(--color-cyan-glow)]"
          style={{
            top: "50%",
            left: i === 0 ? "0" : "100%",
            transform: "translate(-50%, -50%)",
          }}
        />
      ))}
    </motion.div>
  );
}
