import type { TemplateCategory } from "./types";

interface TemplateThumbnailProps {
  category: TemplateCategory;
  /** Optional accent color from the template's default customization */
  color?: string;
  className?: string;
}

// Stylized SVG mockup of a resume layout per category.
// Renders a tiny scaled-down resume so users can preview the structure in dropdowns.
export function TemplateThumbnail({ category, color = "#3b82f6", className }: TemplateThumbnailProps) {
  const accent = color;

  const common = {
    width: "100%",
    height: "100%",
    viewBox: "0 0 64 80",
    className,
    role: "img",
  } as const;

  const Header = ({ label }: { label: string }) => (
    <text x="6" y="14" fontSize="4.5" fill={accent} fontWeight="bold">
      {label}
    </text>
  );

  const Line = ({ x, y, w, h = 1.5, fill = "#cbd5e1" }: { x: number; y: number; w: number; h?: number; fill?: string }) => (
    <rect x={x} y={y} width={w} height={h} rx="0.75" fill={fill} />
  );

  switch (category) {
    case "professional":
    case "classic":
      return (
        <svg {...common}>
          <rect x="0" y="0" width="64" height="80" fill="#ffffff" />
          <Header label="Name" />
          <Line x={6} y={18} w={52} />
          <Line x={6} y={24} w={40} />
          <Line x={6} y={32} w={52} h={2} fill={accent} />
          <Line x={6} y={38} w={52} />
          <Line x={6} y={42} w={46} />
          <Line x={6} y={46} w={50} />
          <Line x={6} y={54} w={52} h={2} fill={accent} />
          <Line x={6} y={60} w={48} />
          <Line x={6} y={64} w={44} />
          <Line x={6} y={70} w={50} />
        </svg>
      );
    case "modern":
      return (
        <svg {...common}>
          <rect x="0" y="0" width="64" height="80" fill="#ffffff" />
          <rect x="0" y="0" width="64" height="16" fill={accent} />
          <text x="6" y="11" fontSize="4.5" fill="#ffffff" fontWeight="bold">
            Name
          </text>
          <Line x={6} y={22} w={52} />
          <Line x={6} y={28} w={44} />
          <Line x={6} y={36} w={24} h={2} fill={accent} />
          <Line x={6} y={42} w={52} />
          <Line x={6} y={46} w={46} />
          <Line x={34} y={36} w={24} h={2} fill={accent} />
          <Line x={34} y={42} w={24} />
          <Line x={34} y={46} w={20} />
        </svg>
      );
    case "minimal":
      return (
        <svg {...common}>
          <rect x="0" y="0" width="64" height="80" fill="#ffffff" />
          <text x="32" y="12" fontSize="5" fill="#0f172a" fontWeight="bold" textAnchor="middle">
            Name
          </text>
          <Line x={20} y={18} w={24} />
          <Line x={14} y={30} w={36} h={1} />
          <Line x={14} y={34} w={32} h={1} />
          <Line x={14} y={38} w={36} h={1} />
          <Line x={14} y={50} w={36} h={1} />
          <Line x={14} y={54} w={30} h={1} />
          <Line x={14} y={58} w={34} h={1} />
          <Line x={14} y={70} w={36} h={1} />
        </svg>
      );
    case "creative":
      return (
        <svg {...common}>
          <rect x="0" y="0" width="64" height="80" fill="#ffffff" />
          <rect x="0" y="0" width="22" height="80" fill={accent} />
          <circle cx="11" cy="16" r="7" fill="#ffffff" opacity="0.9" />
          <rect x="4" y="30" width="14" height="1.5" rx="0.75" fill="#ffffff" opacity="0.85" />
          <rect x="4" y="35" width="10" height={1.5} rx="0.75" fill="#ffffff" opacity="0.7" />
          <rect x="27" y="10" width="30" height={3} rx="1.5" fill="#0f172a" />
          <rect x="27" y="20" width={30} height={1.5} rx="0.75" fill="#cbd5e1" />
          <rect x="27" y={28} width={30} height={1.5} rx="0.75" fill="#cbd5e1" />
          <rect x="27" y={42} width={30} height={1.5} rx="0.75" fill="#cbd5e1" />
          <rect x="27" y={50} width={30} height={1.5} rx="0.75" fill="#cbd5e1" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="0" y="0" width="64" height="80" fill="#ffffff" />
          <Header label="Name" />
          <Line x={6} y={18} w={52} />
          <Line x={6} y={24} w={40} />
          <Line x={6} y={32} w={52} h={2} fill={accent} />
          <Line x={6} y={38} w={52} />
          <Line x={6} y={42} w={46} />
        </svg>
      );
  }
}
