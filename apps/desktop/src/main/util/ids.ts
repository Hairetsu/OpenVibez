import { nanoid } from 'nanoid';

export const makeId = (prefix: string): string => `${prefix}_${nanoid(10)}`;
