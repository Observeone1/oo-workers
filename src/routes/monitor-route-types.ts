export type MonitorRouteResult =
  | { status: 200; body: unknown }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } };
