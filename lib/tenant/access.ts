/** App-layer IDOR guard — complements PostgreSQL RLS (DIR §4.2). */
export function canAccessProject(args: {
  customerId: string;
  projectCustomerId: string;
}): boolean {
  return args.customerId === args.projectCustomerId;
}
