import type { Phone } from '../../shared/api/phones.js';

export type ViewPhone = Phone & { flag: string };

export type Permission = (permission: string) => boolean;
