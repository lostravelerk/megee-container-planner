type MegeeLogoProps = {
  compact?: boolean;
  className?: string;
};

export default function MegeeLogo({
  compact = false,
  className = "",
}: MegeeLogoProps) {
  return (
    <span
      className={`megee-logo-crop${compact ? " megee-logo-crop--symbol" : ""}${className ? ` ${className}` : ""}`}
    >
      <Image
        src="/megee-logo.jpg"
        alt="MEGEE COSPACK"
        width={2920}
        height={2608}
        priority
        unoptimized
      />
    </span>
  );
}
import Image from "next/image";
