const base = process.env.BASE_URL || 'http://127.0.0.1:3128';
const runId = Date.now().toString();
const now = Date.now();
const future = (ms) => new Date(now + ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const email = (name) => `${name}-${runId}@example.com`;

async function req(method, path, body, token, raw) {
  const headers = {};
  let payload;
  if (raw !== undefined) {
    payload = raw;
    headers['Content-Type'] = 'application/json';
  } else if (body !== undefined && body !== null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(base + path, {
    method,
    headers: {
      ...headers,
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: payload
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, body: data };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertError(response, status) {
  assert(
    response.status === status,
    `expected ${status} got ${response.status} body=${JSON.stringify(response.body)}`
  );
  assert(
    response.body &&
      typeof response.body === 'object' &&
      !Array.isArray(response.body) &&
      typeof response.body.error === 'string' &&
      Object.keys(response.body).length === 1,
    `expected error body shape got ${JSON.stringify(response.body)}`
  );
}

function assertSuccess(response, status) {
  assert(
    response.status === status,
    `expected ${status} got ${response.status} body=${JSON.stringify(response.body)}`
  );
  assert(
    !JSON.stringify(response.body).includes('password'),
    'response leaked password'
  );
}

async function main() {
  const organizerEmail = email('orga');
  const organizerBEmail = email('orgb');
  const customerAEmail = email('custa');
  const customerBEmail = email('custb');
  const customerCEmail = email('custc');

  const organizer = await req('POST', '/users', {
    email: organizerEmail,
    password: 'password1',
    name: 'Org A',
    role: 'organizer'
  });
  assertSuccess(organizer, 201);

  const organizerB = await req('POST', '/users', {
    email: organizerBEmail,
    password: 'password1',
    name: 'Org B',
    role: 'organizer'
  });
  assertSuccess(organizerB, 201);

  const customerA = await req('POST', '/users', {
    email: customerAEmail,
    password: 'password1',
    name: 'Cust A',
    role: 'customer'
  });
  assertSuccess(customerA, 201);

  const customerB = await req('POST', '/users', {
    email: customerBEmail,
    password: 'password1',
    name: 'Cust B',
    role: 'customer'
  });
  assertSuccess(customerB, 201);

  const customerC = await req('POST', '/users', {
    email: customerCEmail,
    password: 'password1',
    name: 'Cust C',
    role: 'customer'
  });
  assertSuccess(customerC, 201);

  const duplicateEmail = await req('POST', '/users', {
    email: organizerEmail.toUpperCase(),
    password: 'password1',
    name: 'Dup',
    role: 'organizer'
  });
  assertError(duplicateEmail, 409);

  const badJson = await req('POST', '/sessions', undefined, undefined, '{');
  assertError(badJson, 400);

  const wrongPassword = await req('POST', '/sessions', {
    email: organizerEmail,
    password: 'wrongpass'
  });
  assertError(wrongPassword, 401);

  const organizerSession = await req('POST', '/sessions', {
    email: organizerEmail,
    password: 'password1'
  });
  assertSuccess(organizerSession, 200);

  const organizerBSession = await req('POST', '/sessions', {
    email: organizerBEmail,
    password: 'password1'
  });
  assertSuccess(organizerBSession, 200);

  const customerASession = await req('POST', '/sessions', {
    email: customerAEmail,
    password: 'password1'
  });
  assertSuccess(customerASession, 200);

  const customerBSession = await req('POST', '/sessions', {
    email: customerBEmail,
    password: 'password1'
  });
  assertSuccess(customerBSession, 200);

  const customerCSession = await req('POST', '/sessions', {
    email: customerCEmail,
    password: 'password1'
  });
  assertSuccess(customerCSession, 200);

  const organizerToken = organizerSession.body.token;
  const organizerBToken = organizerBSession.body.token;
  const customerAToken = customerASession.body.token;
  const customerBToken = customerBSession.body.token;
  const customerCToken = customerCSession.body.token;

  assert(typeof organizerToken === 'string', 'missing organizer token');
  assertSuccess(await req('GET', '/me', null, organizerToken), 200);
  assertError(await req('GET', '/me'), 401);
  assertError(
    await req(
      'POST',
      '/events',
      { title: 'x', venue: 'y', startsAt: 'bad', tiers: [] },
      customerAToken
    ),
    403
  );

  const eventMainResponse = await req('POST', '/events', {
    title: 'Jazz Night',
    venue: 'Blue Hall',
    startsAt: future(72 * 3600 * 1000),
    tiers: [
      { name: 'GA', priceCents: 5000, quantity: 5 },
      { name: 'VIP', priceCents: 12000, quantity: 2 }
    ]
  }, organizerToken);
  assertSuccess(eventMainResponse, 201);

  const eventSoonResponse = await req('POST', '/events', {
    title: 'Soon Show',
    venue: 'Red Room',
    startsAt: future(2 * 3600 * 1000),
    tiers: [{ name: 'Soon', priceCents: 4000, quantity: 5 }]
  }, organizerToken);
  assertSuccess(eventSoonResponse, 201);

  const eventSearchResponse = await req('POST', '/events', {
    title: 'Acoustic Evening',
    venue: 'Grand Hall',
    startsAt: future(96 * 3600 * 1000),
    tiers: [{ name: 'Std', priceCents: 3000, quantity: 3 }]
  }, organizerBToken);
  assertSuccess(eventSearchResponse, 201);

  const eventMain = eventMainResponse.body;
  const eventSoon = eventSoonResponse.body;
  const gaId = eventMain.tiers.find((tier) => tier.name === 'GA').id;
  const vipId = eventMain.tiers.find((tier) => tier.name === 'VIP').id;
  const soonTierId = eventSoon.tiers[0].id;

  const listAll = await req('GET', '/events');
  assertSuccess(listAll, 200);
  assert(listAll.body.total === 3, 'expected 3 events');
  assert(
    listAll.body.items[0].id === eventSoon.id &&
      listAll.body.items[1].id === eventMain.id &&
      listAll.body.items[2].id === eventSearchResponse.body.id,
    'unexpected event sort order'
  );

  const queryList = await req('GET', '/events?q=hall');
  assertSuccess(queryList, 200);
  assert(queryList.body.items.length === 2, 'expected hall search matches 2');

  const page1 = await req('GET', '/events?page=1&pageSize=1');
  assertSuccess(page1, 200);
  assert(page1.body.items.length === 1 && page1.body.total === 3, 'pagination mismatch');
  assertError(await req('GET', '/events?page=0'), 400);

  const detail = await req('GET', `/events/${eventMain.id}`);
  assertSuccess(detail, 200);
  assert(detail.body.tiers.find((tier) => tier.id === gaId).available === 5, 'expected GA available 5');

  const percentDiscount = await req(
    'POST',
    `/events/${eventMain.id}/discounts`,
    { code: 'save10', percentOff: 10, maxUses: 1, expiresAt: future(24 * 3600 * 1000) },
    organizerToken
  );
  assertSuccess(percentDiscount, 201);
  assert(percentDiscount.body.code === 'SAVE10' && percentDiscount.body.uses === 0, 'discount create mismatch');

  const amountDiscount = await req(
    'POST',
    `/events/${eventSoon.id}/discounts`,
    { code: 'BIGOFF', amountOffCents: 7000 },
    organizerToken
  );
  assertSuccess(amountDiscount, 201);

  assertError(await req('POST', `/events/${eventMain.id}/discounts`, { code: 'xx' }, customerAToken), 403);

  const discountedOrder = await req('POST', '/orders', {
    eventId: eventMain.id,
    items: [{ tierId: vipId, quantity: 1 }],
    discountCode: 'save10'
  }, customerAToken);
  assertSuccess(discountedOrder, 201);
  assert(
    discountedOrder.body.discountCode === 'SAVE10' &&
      discountedOrder.body.subtotalCents === 12000 &&
      discountedOrder.body.discountCents === 1200 &&
      discountedOrder.body.totalCents === 10800,
    'percent discount mismatch'
  );

  assertError(
    await req('POST', '/orders', {
      eventId: eventMain.id,
      items: [{ tierId: gaId, quantity: 1 }],
      discountCode: 'SAVE10'
    }, customerBToken),
    422
  );

  const cancelDiscounted = await req('POST', `/orders/${discountedOrder.body.id}/cancel`, {}, customerAToken);
  assertSuccess(cancelDiscounted, 200);
  assert(cancelDiscounted.body.status === 'cancelled', 'discounted order not cancelled');

  const reusedDiscount = await req('POST', '/orders', {
    eventId: eventMain.id,
    items: [{ tierId: gaId, quantity: 1 }],
    discountCode: 'SAVE10'
  }, customerBToken);
  assertSuccess(reusedDiscount, 201);

  const payReused = await req('POST', `/orders/${reusedDiscount.body.id}/pay`, {}, customerBToken);
  assertSuccess(payReused, 200);
  assert(payReused.body.status === 'paid' && typeof payReused.body.paidAt === 'string', 'order not paid');
  assertError(await req('POST', `/orders/${reusedDiscount.body.id}/pay`, {}, customerAToken), 404);

  const amountOrder = await req('POST', '/orders', {
    eventId: eventSoon.id,
    items: [{ tierId: soonTierId, quantity: 1 }],
    discountCode: 'bigoff'
  }, customerAToken);
  assertSuccess(amountOrder, 201);
  assert(amountOrder.body.discountCents === 4000 && amountOrder.body.totalCents === 0, 'amount discount cap mismatch');

  const paySoon = await req('POST', `/orders/${amountOrder.body.id}/pay`, {}, customerAToken);
  assertSuccess(paySoon, 200);
  assertError(await req('POST', `/orders/${amountOrder.body.id}/cancel`, {}, customerAToken), 409);

  const held1 = await req('POST', '/orders', {
    eventId: eventMain.id,
    items: [{ tierId: gaId, quantity: 2 }]
  }, customerAToken);
  assertSuccess(held1, 201);

  const held2 = await req('POST', '/orders', {
    eventId: eventMain.id,
    items: [{ tierId: gaId, quantity: 2 }]
  }, customerCToken);
  assertSuccess(held2, 201);

  const soldOutDetail = await req('GET', `/events/${eventMain.id}`);
  assertSuccess(soldOutDetail, 200);
  assert(soldOutDetail.body.tiers.find((tier) => tier.id === gaId).available === 0, 'expected sold out');

  const wait1 = await req('POST', `/events/${eventMain.id}/waitlist`, { tierId: gaId, quantity: 2 }, customerBToken);
  assertSuccess(wait1, 201);

  const wait2 = await req('POST', `/events/${eventMain.id}/waitlist`, { tierId: gaId, quantity: 1 }, customerAToken);
  assertSuccess(wait2, 201);

  const customerBWaitlist = await req('GET', '/me/waitlist', null, customerBToken);
  assertSuccess(customerBWaitlist, 200);
  assert(customerBWaitlist.body[0].position === 1, 'waitlist position 1 expected');

  const cancelHeld1 = await req('POST', `/orders/${held1.body.id}/cancel`, {}, customerAToken);
  assertSuccess(cancelHeld1, 200);

  const customerBOrders = await req('GET', '/me/orders', null, customerBToken);
  assertSuccess(customerBOrders, 200);
  const autoHeld = customerBOrders.body.find(
    (order) =>
      order.eventId === eventMain.id &&
      order.status === 'held' &&
      order.discountCode === null &&
      order.items.length === 1 &&
      order.items[0].quantity === 2
  );
  assert(autoHeld, 'expected waitlist-created held order for customer B');

  const customerAWaitlist = await req('GET', '/me/waitlist', null, customerAToken);
  assertSuccess(customerAWaitlist, 200);
  assert(customerAWaitlist.body.length === 1 && customerAWaitlist.body[0].position === 1, 'second waitlist entry should remain position 1');

  const reportBeforeCancel = await req('GET', `/events/${eventMain.id}/report`, null, organizerToken);
  assertSuccess(reportBeforeCancel, 200);
  assert(
    reportBeforeCancel.body.grossCents === 5000 &&
      reportBeforeCancel.body.discountCents === 500 &&
      reportBeforeCancel.body.netCents === 4500,
    'report paid totals mismatch'
  );

  assertError(await req('GET', `/orders/${reusedDiscount.body.id}`, null, customerCToken), 404);
  assertSuccess(await req('GET', `/orders/${reusedDiscount.body.id}`, null, organizerToken), 200);
  assertError(await req('POST', `/events/${eventMain.id}/cancel`, {}, organizerBToken), 403);

  const cancelEvent = await req('POST', `/events/${eventMain.id}/cancel`, {}, organizerToken);
  assertSuccess(cancelEvent, 200);
  assert(cancelEvent.body.status === 'cancelled', 'event not cancelled');

  const paidAfterEventCancel = await req('GET', `/orders/${reusedDiscount.body.id}`, null, organizerToken);
  assertSuccess(paidAfterEventCancel, 200);
  assert(paidAfterEventCancel.body.status === 'refunded', 'paid order should be refunded after event cancel');

  const autoHeldAfterCancel = await req('GET', `/orders/${autoHeld.id}`, null, customerBToken);
  assertSuccess(autoHeldAfterCancel, 200);
  assert(autoHeldAfterCancel.body.status === 'cancelled', 'held order should be cancelled after event cancel');

  const eventsAfterCancel = await req('GET', '/events');
  assertSuccess(eventsAfterCancel, 200);
  assert(
    eventsAfterCancel.body.total === 2 && !eventsAfterCancel.body.items.some((event) => event.id === eventMain.id),
    'cancelled event should disappear from list'
  );

  const waitAfterCancel = await req('GET', '/me/waitlist', null, customerAToken);
  assertSuccess(waitAfterCancel, 200);
  assert(waitAfterCancel.body.length === 0, 'waitlist should be emptied on event cancel');

  const expiryEvent = await req('POST', '/events', {
    title: 'Expiry Show',
    venue: 'Tiny Room',
    startsAt: future(80 * 3600 * 1000),
    tiers: [{ name: 'Only', priceCents: 2500, quantity: 1 }]
  }, organizerToken);
  assertSuccess(expiryEvent, 201);
  const expiryTierId = expiryEvent.body.tiers[0].id;

  const expiryDiscount = await req(
    'POST',
    `/events/${expiryEvent.body.id}/discounts`,
    { code: 'ONEUSE', percentOff: 50, maxUses: 1 },
    organizerToken
  );
  assertSuccess(expiryDiscount, 201);

  const expiryOrder = await req('POST', '/orders', {
    eventId: expiryEvent.body.id,
    items: [{ tierId: expiryTierId, quantity: 1 }],
    discountCode: 'oneuse'
  }, customerAToken);
  assertSuccess(expiryOrder, 201);

  const expiryWaitlist = await req('POST', `/events/${expiryEvent.body.id}/waitlist`, {
    tierId: expiryTierId,
    quantity: 1
  }, customerBToken);
  assertSuccess(expiryWaitlist, 201);

  await sleep(3100);

  assertError(await req('POST', `/orders/${expiryOrder.body.id}/pay`, {}, customerAToken), 409);

  const expiredOrder = await req('GET', `/orders/${expiryOrder.body.id}`, null, customerAToken);
  assertSuccess(expiredOrder, 200);
  assert(expiredOrder.body.status === 'expired', 'order should be expired');

  const afterExpireEvent = await req('GET', `/events/${expiryEvent.body.id}`);
  assertSuccess(afterExpireEvent, 200);
  assert(afterExpireEvent.body.tiers[0].available === 0, 'waitlist should consume released ticket into held order');

  const customerBOrdersAfterExpire = await req('GET', '/me/orders', null, customerBToken);
  assertSuccess(customerBOrdersAfterExpire, 200);
  const expireAutoHeld = customerBOrdersAfterExpire.body.find(
    (order) => order.eventId === expiryEvent.body.id && order.status === 'held'
  );
  assert(expireAutoHeld, 'waitlist should create held order after expiry');

  assertError(
    await req('POST', '/orders', {
      eventId: expiryEvent.body.id,
      items: [{ tierId: expiryTierId, quantity: 1 }],
      discountCode: 'ONEUSE'
    }, customerCToken),
    409
  );

  const reportSoon = await req('GET', `/events/${eventSoon.id}/report`, null, organizerToken);
  assertSuccess(reportSoon, 200);
  assert(reportSoon.body.refundedCents === 0 && reportSoon.body.netCents === 0, 'soon event report mismatch');

  console.log('VERIFICATION_OK');
}

main().catch((error) => {
  console.error('VERIFICATION_FAILED');
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
