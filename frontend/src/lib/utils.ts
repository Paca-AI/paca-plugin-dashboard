// Ported verbatim from apps/web/src/lib/utils.ts (cn() only — cleanBlocks
// is unused here and stays host-only).
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
