import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

type Role = 'organizer' | 'customer';
type EventStatus = 'on_sale' | 'cancelled';
type OrderStatus = 'held' | 'paid' | 'expired' | 'cancelled' | 'refunded';

type UserRecord = {
  id: string;
  email: string;
  emailLower: string;
  password: string;
  name: string;
  role: Role;
};

type SessionRecord = {
  token: string;
  userId: string;
};

type EventTierRecord = {
  id: string;
  name: string;
  priceCents: number;
  quantity: number;
};

type EventRecord = {
  id: string;
  title: string;
  venue: string;
  startsAt: string;
  status: EventStatus;
  organizerId: string;
  tiers: EventTierRecord[];
};

type OrderItemRecord = {
  tierId: string;
  quantity: number;
  unitPriceCents: number;
};

type OrderRecord = {
  id: string;
  eventId: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItemRecord[];
  subtotalCents: number;
  discountCode: string | null;
  discountCents: number;
  totalCents: number;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
};

type DiscountRecord = {
  eventId: string;
  code: string;
  percentOff: number | null;
  amountOffCents: number | null;
  maxUses: number | null;
  expiresAt: string | null;
};

type WaitlistEntryRecord = {
  id: string;
  eventId: string;
  tierId: string;
  customerId: string;
  quantity: number;
  createdAt: string;
};

const holdSecondsRaw = process.env.HOLD_SECONDS;
const holdSeconds = holdSecondsRaw === undefined ? 600 : Number(holdSecondsRaw);
if (!Number.isInteger(holdSeconds) || holdSeconds <= 0) {
  throw new Error('Invalid HOLD_SECONDS');
}
const portRaw = process.env.PORT;
if (!portRaw) {
  throw new Error('PORT is required');
}
const port = Number(portRaw);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error('Invalid PORT');
}

const users = new Map<string, UserRecord>();
const sessions = new Map<string, SessionRecord>();
const events = new Map<string, EventRecord>();
const orders = new Map<string, OrderRecord>();
const discounts = new Map<string, Map<string, DiscountRecord>>();
const waitlists = new Map<string, WaitlistEntryRecord[]>();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function error(res: http.ServerResponse, status: number, message: string): void {
  json(res, status, { error: message });
}

function makeId(): string {
  return randomUUID();
}

function now(): Date {
  return new Date();
}

function toIso(value: string | Date): string {
  return (typeof value === 'string' ? new Date(value) : value).toISOString();
}

function userView(user: UserRecord) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function getSessionUser(req: http.IncomingMessage): UserRecord {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new HttpError(401, 'Unauthorized');
  }
  const token = header.slice(7);
  const session = sessions.get(token);
  if (!session) {
    throw new HttpError(401, 'Unauthorized');
  }
  const user = users.get(session.userId);
  if (!user) {
    throw new HttpError(401, 'Unauthorized');
  }
  return user;
}

function requireRole(user: UserRecord, role: Role): void {
  if (user.role !== role) {
    throw new HttpError(403, 'Forbidden');
  }
}

function parseDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function validateEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  const at = email.indexOf('@');
  if (at <= 0) return false;
  return email.indexOf('.', at + 1) > at + 1;
}

function expireOrdersAndServeWaitlists(): void {
  const current = now();
  const releasedEvents = new Set<string>();
  for (const order of orders.values()) {
    if (order.status === 'held' && new Date(order.expiresAt).getTime() < current.getTime()) {
      order.status = 'expired';
      releasedEvents.add(order.eventId);
    }
  }
  for (const eventId of releasedEvents) {
    const event = events.get(eventId);
    if (event) {
      for (const tier of event.tiers) {
        serveWaitlist(eventId, tier.id);
      }
    }
  }
}

function activeOrder(order: OrderRecord): boolean {
  return order.status === 'held' || order.status === 'paid';
}

function activeDiscountUse(order: OrderRecord, code: string): boolean {
  return (order.status === 'held' || order.status === 'paid') && order.discountCode === code;
}

function getTierAvailability(event: EventRecord, tierId: string): number {
  const tier = event.tiers.find((item) => item.id === tierId);
  if (!tier) return 0;
  let reserved = 0;
  for (const order of orders.values()) {
    if (!activeOrder(order) || order.eventId !== event.id) continue;
    for (const item of order.items) {
      if (item.tierId === tierId) reserved += item.quantity;
    }
  }
  return tier.quantity - reserved;
}

function eventView(event: EventRecord) {
  return {
    id: event.id,
    title: event.title,
    venue: event.venue,
    startsAt: toIso(event.startsAt),
    status: event.status,
    organizerId: event.organizerId,
    tiers: event.tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      priceCents: tier.priceCents,
      quantity: tier.quantity,
      available: getTierAvailability(event, tier.id)
    }))
  };
}

function orderView(order: OrderRecord) {
  return {
    id: order.id,
    eventId: order.eventId,
    customerId: order.customerId,
    status: order.status,
    items: order.items.map((item) => ({ ...item })),
    subtotalCents: order.subtotalCents,
    discountCode: order.discountCode,
    discountCents: order.discountCents,
    totalCents: order.totalCents,
    createdAt: toIso(order.createdAt),
    expiresAt: toIso(order.expiresAt),
    paidAt: order.paidAt ? toIso(order.paidAt) : null
  };
}

function customerTicketCountForEvent(customerId: string, eventId: string): number {
  let total = 0;
  for (const order of orders.values()) {
    if (order.customerId !== customerId || order.eventId !== eventId) continue;
    if (!(order.status === 'held' || order.status === 'paid')) continue;
    total += order.items.reduce((sum, item) => sum + item.quantity, 0);
  }
  return total;
}

function getDiscount(eventId: string, codeInput: string): DiscountRecord | null {
  const map = discounts.get(eventId);
  if (!map) return null;
  return map.get(codeInput.toUpperCase()) ?? null;
}

function discountUses(eventId: string, code: string): number {
  let count = 0;
  for (const order of orders.values()) {
    if (order.eventId === eventId && activeDiscountUse(order, code)) count += 1;
  }
  return count;
}

function computeDiscount(subtotalCents: number, discount: DiscountRecord | null): { code: string | null; discountCents: number } {
  if (!discount) return { code: null, discountCents: 0 };
  if (discount.percentOff !== null) {
    return { code: discount.code, discountCents: Math.floor((subtotalCents * discount.percentOff) / 100) };
  }
  return { code: discount.code, discountCents: Math.min(discount.amountOffCents ?? 0, subtotalCents) };
}

function validateDiscountUsable(eventId: string, codeInput: unknown): DiscountRecord | null {
  if (codeInput === undefined) return null;
  if (typeof codeInput !== 'string') throw new HttpError(400, 'Invalid discountCode');
  const discount = getDiscount(eventId, codeInput);
  if (!discount) throw new HttpError(422, 'Discount cannot be used');
  if (discount.expiresAt && new Date(discount.expiresAt).getTime() < now().getTime()) {
    throw new HttpError(422, 'Discount cannot be used');
  }
  if (discount.maxUses !== null && discountUses(eventId, discount.code) >= discount.maxUses) {
    throw new HttpError(422, 'Discount cannot be used');
  }
  return discount;
}

function createHeldOrder(event: EventRecord, customerId: string, items: { tierId: string; quantity: number }[], discount: DiscountRecord | null): OrderRecord {
  const pricedItems = items.map((item) => {
    const tier = event.tiers.find((t) => t.id === item.tierId)!;
    return { tierId: item.tierId, quantity: item.quantity, unitPriceCents: tier.priceCents };
  });
  const subtotalCents = pricedItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  const discountInfo = computeDiscount(subtotalCents, discount);
  const createdAt = now();
  const expiresAt = new Date(createdAt.getTime() + holdSeconds * 1000);
  const order: OrderRecord = {
    id: makeId(),
    eventId: event.id,
    customerId,
    status: 'held',
    items: pricedItems,
    subtotalCents,
    discountCode: discountInfo.code,
    discountCents: discountInfo.discountCents,
    totalCents: subtotalCents - discountInfo.discountCents,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    paidAt: null
  };
  orders.set(order.id, order);
  return order;
}

function serveWaitlist(eventId: string, tierId: string): void {
  const event = events.get(eventId);
  if (!event || event.status !== 'on_sale') return;
  const queue = waitlists.get(tierId) ?? [];
  while (queue.length > 0) {
    const first = queue[0];
    const available = getTierAvailability(event, tierId);
    if (available < first.quantity) break;
    const ticketCount = customerTicketCountForEvent(first.customerId, eventId);
    if (ticketCount + first.quantity > 6) {
      queue.shift();
      continue;
    }
    createHeldOrder(event, first.customerId, [{ tierId, quantity: first.quantity }], null);
    queue.shift();
  }
  if (queue.length === 0) {
    waitlists.delete(tierId);
  } else {
    waitlists.set(tierId, queue);
  }
}

function waitlistView(entry: WaitlistEntryRecord) {
  const queue = waitlists.get(entry.tierId) ?? [];
  const position = queue.findIndex((item) => item.id === entry.id) + 1;
  return { id: entry.id, eventId: entry.eventId, tierId: entry.tierId, quantity: entry.quantity, position };
}

async function handleEventSubroutes(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const reportMatch = path.match(/^\/events\/([^/]+)\/report$/);
  if (req.method === 'GET' && reportMatch) {
    const user = getSessionUser(req);
    requireRole(user, 'organizer');
    const event = events.get(reportMatch[1]);
    if (!event) throw new HttpError(404, 'Not found');
    if (event.organizerId !== user.id) throw new HttpError(403, 'Forbidden');
    const tiers = event.tiers.map((tier) => {
      let sold = 0;
      let held = 0;
      for (const order of orders.values()) {
        if (order.eventId !== event.id) continue;
        for (const item of order.items) {
          if (item.tierId !== tier.id) continue;
          if (order.status === 'paid') sold += item.quantity;
          if (order.status === 'held') held += item.quantity;
        }
      }
      return { tierId: tier.id, name: tier.name, sold, held, available: getTierAvailability(event, tier.id) };
    });
    let grossCents = 0;
    let discountCents = 0;
    let refundedCents = 0;
    let netCents = 0;
    for (const order of orders.values()) {
      if (order.eventId !== event.id) continue;
      if (order.status === 'paid') {
        grossCents += order.subtotalCents;
        discountCents += order.discountCents;
        netCents += order.totalCents;
      }
      if (order.status === 'refunded') refundedCents += order.totalCents;
    }
    json(res, 200, { eventId: event.id, tiers, grossCents, discountCents, refundedCents, netCents });
    return true;
  }

  const cancelMatch = path.match(/^\/events\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const user = getSessionUser(req);
    requireRole(user, 'organizer');
    const body = await readJsonBody(req);
    if (!isObject(body)) throw new HttpError(400, 'Invalid input');
    const event = events.get(cancelMatch[1]);
    if (!event) throw new HttpError(404, 'Not found');
    if (event.organizerId !== user.id) throw new HttpError(403, 'Forbidden');
    if (event.status === 'cancelled') throw new HttpError(409, 'Event already cancelled');
    event.status = 'cancelled';
    for (const order of orders.values()) {
      if (order.eventId !== event.id) continue;
      if (order.status === 'paid') order.status = 'refunded';
      if (order.status === 'held') order.status = 'cancelled';
    }
    for (const tier of event.tiers) {
      waitlists.delete(tier.id);
    }
    json(res, 200, eventView(event));
    return true;
  }

  const discountMatch = path.match(/^\/events\/([^/]+)\/discounts$/);
  if (req.method === 'POST' && discountMatch) {
    const user = getSessionUser(req);
    requireRole(user, 'organizer');
    const body = await readJsonBody(req);
    if (!isObject(body)) throw new HttpError(400, 'Invalid input');
    const event = events.get(discountMatch[1]);
    if (!event) throw new HttpError(404, 'Not found');
    if (event.organizerId !== user.id) throw new HttpError(403, 'Forbidden');
    const code = typeof body.code === 'string' ? body.code.toUpperCase() : null;
    const percentValid = Number.isInteger(body.percentOff) && (body.percentOff as number) >= 1 && (body.percentOff as number) <= 100;
    const amountValid = Number.isInteger(body.amountOffCents) && (body.amountOffCents as number) >= 1;
    const exactlyOne = (percentValid ? 1 : 0) + (amountValid ? 1 : 0) === 1;
    const maxUsesValid = body.maxUses === undefined || (Number.isInteger(body.maxUses) && (body.maxUses as number) >= 1);
    const expiresAt = body.expiresAt === undefined ? null : parseDateString(body.expiresAt);
    if (!code || !/^[A-Z0-9]{3,20}$/.test(code) || !exactlyOne || !maxUsesValid || (body.expiresAt !== undefined && !expiresAt)) throw new HttpError(400, 'Invalid input');
    const eventDiscounts = discounts.get(event.id) ?? new Map<string, DiscountRecord>();
    if (eventDiscounts.has(code)) throw new HttpError(409, 'Discount already exists');
    const discount: DiscountRecord = { eventId: event.id, code, percentOff: percentValid ? body.percentOff as number : null, amountOffCents: amountValid ? body.amountOffCents as number : null, maxUses: body.maxUses === undefined ? null : body.maxUses as number, expiresAt };
    eventDiscounts.set(code, discount);
    discounts.set(event.id, eventDiscounts);
    json(res, 201, { ...discount, uses: discountUses(event.id, code) });
    return true;
  }

  const waitlistMatch = path.match(/^\/events\/([^/]+)\/waitlist$/);
  if (req.method === 'POST' && waitlistMatch) {
    const user = getSessionUser(req);
    requireRole(user, 'customer');
    const body = await readJsonBody(req);
    if (!isObject(body) || typeof body.tierId !== 'string' || !Number.isInteger(body.quantity) || (body.quantity as number) < 1 || (body.quantity as number) > 6) throw new HttpError(400, 'Invalid input');
    const event = events.get(waitlistMatch[1]);
    if (!event) throw new HttpError(404, 'Not found');
    const tier = event.tiers.find((item) => item.id === body.tierId);
    if (!tier) throw new HttpError(404, 'Not found');
    const queue = waitlists.get(tier.id) ?? [];
    if (queue.some((entry) => entry.customerId === user.id)) throw new HttpError(409, 'Already on waitlist');
    if (getTierAvailability(event, tier.id) >= (body.quantity as number)) throw new HttpError(409, 'Tickets available');
    const entry: WaitlistEntryRecord = { id: makeId(), eventId: event.id, tierId: tier.id, customerId: user.id, quantity: body.quantity as number, createdAt: now().toISOString() };
    queue.push(entry);
    waitlists.set(tier.id, queue);
    json(res, 201, waitlistView(entry));
    return true;
  }

  const eventMatch = path.match(/^\/events\/([^/]+)$/);
  if (req.method === 'GET' && eventMatch) {
    const event = events.get(eventMatch[1]);
    if (!event) throw new HttpError(404, 'Not found');
    json(res, 200, eventView(event));
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    expireOrdersAndServeWaitlists();
    if (!req.url || !req.method) {
      throw new HttpError(404, 'Not found');
    }
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;
    const method = req.method;

    if (method === 'POST' && path === '/users') {
      const body = await readJsonBody(req);
      if (!isObject(body) || !validateEmail(body.email) || typeof body.password !== 'string' || body.password.length < 8 || typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100 || (body.role !== 'organizer' && body.role !== 'customer')) {
        throw new HttpError(400, 'Invalid input');
      }
      const email = body.email;
      const password = body.password;
      const name = body.name;
      const role = body.role;
      const emailLower = email.toLowerCase();
      for (const user of users.values()) {
        if (user.emailLower === emailLower) throw new HttpError(409, 'Email already registered');
      }
      const user: UserRecord = { id: makeId(), email, emailLower, password, name, role };
      users.set(user.id, user);
      return json(res, 201, userView(user));
    }

    if (method === 'POST' && path === '/sessions') {
      const body = await readJsonBody(req);
      if (!isObject(body) || typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw new HttpError(400, 'Invalid input');
      }
      const email = body.email;
      const password = body.password;
      const user = [...users.values()].find((item) => item.emailLower === email.toLowerCase() && item.password === password);
      if (!user) throw new HttpError(401, 'Unauthorized');
      const token = makeId();
      sessions.set(token, { token, userId: user.id });
      return json(res, 200, { token });
    }

    if (method === 'GET' && path === '/me') {
      const user = getSessionUser(req);
      return json(res, 200, userView(user));
    }

    if (method === 'POST' && path === '/events') {
      const user = getSessionUser(req);
      requireRole(user, 'organizer');
      const body = await readJsonBody(req);
      if (!isObject(body) || typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 100 || typeof body.venue !== 'string' || body.venue.length < 1 || body.venue.length > 100) {
        throw new HttpError(400, 'Invalid input');
      }
      const startsAt = parseDateString(body.startsAt);
      if (!startsAt || new Date(startsAt).getTime() <= now().getTime()) throw new HttpError(400, 'Invalid input');
      if (!Array.isArray(body.tiers) || body.tiers.length < 1 || body.tiers.length > 5) throw new HttpError(400, 'Invalid input');
      const seen = new Set<string>();
      const tiers: EventTierRecord[] = [];
      for (const tier of body.tiers) {
        if (!isObject(tier) || typeof tier.name !== 'string' || seen.has(tier.name) || !Number.isInteger(tier.priceCents) || (tier.priceCents as number) < 0 || !Number.isInteger(tier.quantity) || (tier.quantity as number) < 1 || (tier.quantity as number) > 10000) {
          throw new HttpError(400, 'Invalid input');
        }
        seen.add(tier.name);
        tiers.push({ id: makeId(), name: tier.name, priceCents: tier.priceCents as number, quantity: tier.quantity as number });
      }
      const event: EventRecord = { id: makeId(), title: body.title, venue: body.venue, startsAt, status: 'on_sale', organizerId: user.id, tiers };
      events.set(event.id, event);
      return json(res, 201, eventView(event));
    }

    if (method === 'GET' && path === '/events') {
      const fromRaw = url.searchParams.get('from');
      const toRaw = url.searchParams.get('to');
      const qRaw = url.searchParams.get('q');
      const pageRaw = url.searchParams.get('page');
      const pageSizeRaw = url.searchParams.get('pageSize');
      const from = fromRaw === null ? null : parseDateString(fromRaw);
      const to = toRaw === null ? null : parseDateString(toRaw);
      if ((fromRaw !== null && !from) || (toRaw !== null && !to)) throw new HttpError(400, 'Invalid input');
      const page = pageRaw === null ? 1 : Number(pageRaw);
      const pageSize = pageSizeRaw === null ? 10 : Number(pageSizeRaw);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new HttpError(400, 'Invalid input');
      const q = qRaw === null ? null : qRaw.toLowerCase();
      const filtered = [...events.values()]
        .filter((event) => event.status === 'on_sale')
        .filter((event) => !from || new Date(event.startsAt).getTime() >= new Date(from).getTime())
        .filter((event) => !to || new Date(event.startsAt).getTime() <= new Date(to).getTime())
        .filter((event) => !q || event.title.toLowerCase().includes(q) || event.venue.toLowerCase().includes(q))
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || a.title.localeCompare(b.title));
      const total = filtered.length;
      const start = (page - 1) * pageSize;
      return json(res, 200, { items: filtered.slice(start, start + pageSize).map(eventView), page, pageSize, total });
    }

    if (path.startsWith('/events/') && await handleEventSubroutes(req, res, path)) {
      return;
    }

    if (method === 'POST' && path === '/orders') {
      const user = getSessionUser(req);
      requireRole(user, 'customer');
      const body = await readJsonBody(req);
      if (!isObject(body) || typeof body.eventId !== 'string' || !Array.isArray(body.items) || body.items.length < 1) throw new HttpError(400, 'Invalid input');
      const seen = new Set<string>();
      const items: { tierId: string; quantity: number }[] = [];
      for (const item of body.items) {
        if (!isObject(item) || typeof item.tierId !== 'string' || seen.has(item.tierId) || !Number.isInteger(item.quantity) || (item.quantity as number) < 1) throw new HttpError(400, 'Invalid input');
        seen.add(item.tierId);
        items.push({ tierId: item.tierId, quantity: item.quantity as number });
      }
      const event = events.get(body.eventId);
      if (!event) throw new HttpError(404, 'Not found');
      const tierMap = new Map(event.tiers.map((tier) => [tier.id, tier]));
      for (const item of items) {
        if (!tierMap.has(item.tierId)) throw new HttpError(400, 'Invalid tier');
      }
      if (event.status !== 'on_sale' || new Date(event.startsAt).getTime() <= now().getTime()) throw new HttpError(409, 'Event not available');
      for (const item of items) {
        if (getTierAvailability(event, item.tierId) < item.quantity) throw new HttpError(409, 'Not enough tickets');
      }
      const totalRequested = items.reduce((sum, item) => sum + item.quantity, 0);
      if (customerTicketCountForEvent(user.id, event.id) + totalRequested > 6) throw new HttpError(422, 'Ticket limit exceeded');
      const discount = validateDiscountUsable(event.id, body.discountCode);
      const order = createHeldOrder(event, user.id, items, discount);
      return json(res, 201, orderView(order));
    }

    if (path.startsWith('/orders/')) {
      const payMatch = path.match(/^\/orders\/([^/]+)\/pay$/);
      if (method === 'POST' && payMatch) {
        const user = getSessionUser(req);
        requireRole(user, 'customer');
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new HttpError(400, 'Invalid input');
        const order = orders.get(payMatch[1]);
        if (!order || order.customerId !== user.id) throw new HttpError(404, 'Not found');
        if (order.status !== 'held') throw new HttpError(409, 'Order not payable');
        order.status = 'paid';
        order.paidAt = now().toISOString();
        return json(res, 200, orderView(order));
      }

      const cancelMatch = path.match(/^\/orders\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const user = getSessionUser(req);
        requireRole(user, 'customer');
        const body = await readJsonBody(req);
        if (!isObject(body)) throw new HttpError(400, 'Invalid input');
        const order = orders.get(cancelMatch[1]);
        if (!order || order.customerId !== user.id) throw new HttpError(404, 'Not found');
        const event = events.get(order.eventId)!;
        if (order.status === 'held') {
          order.status = 'cancelled';
          for (const item of order.items) serveWaitlist(order.eventId, item.tierId);
          return json(res, 200, orderView(order));
        }
        if (order.status === 'paid') {
          if (new Date(event.startsAt).getTime() - now().getTime() <= 24 * 60 * 60 * 1000) throw new HttpError(409, 'Refund not allowed');
          order.status = 'refunded';
          for (const item of order.items) serveWaitlist(order.eventId, item.tierId);
          return json(res, 200, orderView(order));
        }
        throw new HttpError(409, 'Order cannot be cancelled');
      }

      const getMatch = path.match(/^\/orders\/([^/]+)$/);
      if (method === 'GET' && getMatch) {
        const user = getSessionUser(req);
        const order = orders.get(getMatch[1]);
        if (!order) throw new HttpError(404, 'Not found');
        const event = events.get(order.eventId);
        if (!event) throw new HttpError(404, 'Not found');
        if (order.customerId !== user.id && event.organizerId !== user.id) throw new HttpError(404, 'Not found');
        return json(res, 200, orderView(order));
      }
    }

    if (method === 'GET' && path === '/me/orders') {
      const user = getSessionUser(req);
      requireRole(user, 'customer');
      const items = [...orders.values()]
        .filter((order) => order.customerId === user.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .map(orderView);
      return json(res, 200, items);
    }

    if (method === 'GET' && path === '/me/waitlist') {
      const user = getSessionUser(req);
      requireRole(user, 'customer');
      const entries: ReturnType<typeof waitlistView>[] = [];
      for (const queue of waitlists.values()) {
        for (const entry of queue) {
          if (entry.customerId === user.id) entries.push(waitlistView(entry));
        }
      }
      return json(res, 200, entries);
    }

    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (err instanceof HttpError) {
      return error(res, err.status, err.message);
    }
    return error(res, 500, 'Internal server error');
  }
});

server.listen(port, () => {
  console.log(`Box Office API listening on ${port}`);
});
