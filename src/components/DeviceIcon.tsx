import {
  Cable,
  HardDrive,
  Monitor,
  Network,
  Usb,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<number, LucideIcon> = {
  0: Cable,
  1: Network,
  2: HardDrive,
  3: Usb,
  4: Monitor,
};

interface Props {
  devType: number;
  className?: string;
}

export function DeviceIcon({ devType, className = 'h-4 w-4' }: Props) {
  const Icon = ICONS[devType] ?? Cable;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.8} />;
}
