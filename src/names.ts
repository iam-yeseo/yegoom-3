/** Display helpers never change stored nicknames or form values. */
export const honorific = (name: string): string => `${name}님`;

/** Ranking labels use the nickname alone; sentences still use honorific(). */
export const plainName = (name: string): string => name;
