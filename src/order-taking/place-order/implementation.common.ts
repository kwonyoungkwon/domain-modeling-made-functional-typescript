import * as Effect from 'effect/Effect';
import { pipe } from 'effect/Function';
import * as O from 'fp-ts/Option';
import { match } from 'ts-pattern';
import { NotSent, OrderAcknowledgement, OrderAcknowledgmentLetterService, OrderAcknowledgmentSenderService, Sent } from './implementation.types';
import { BillableOrderPlaced, OrderAcknowledgmentSent, OrderPlaced, RemoteServiceError } from './public-types';

import type { AcknowledgeOrder, AcknowledgmentEnv, CreateEvents } from './implementation.types';
import type { PlaceOrderEvent, PricedOrder } from './public-types';

// ---------------------------
// AcknowledgeOrder step
// ---------------------------

export const acknowledgeOrder: AcknowledgeOrder = pricedOrder =>
  Effect.gen(function* (_) {
    const letterService = yield* _(OrderAcknowledgmentLetterService);
    const sender = yield* _(OrderAcknowledgmentSenderService);

    const letter = yield* _(letterService.create(pricedOrder));
    const acknowledgment = new OrderAcknowledgement(pricedOrder.customerInfo.emailAddress, letter);

    const result = yield* _(sender.send(acknowledgment));

    return match(result)
      .with(Sent, () => O.some(new OrderAcknowledgmentSent(pricedOrder.orderId, pricedOrder.customerInfo.emailAddress)))
      .with(NotSent, () => O.none)
      .exhaustive();
  });

// ---------------------------
// Create events
// ---------------------------

export const createOrderPlacedEvent = (i: PricedOrder) =>
  new OrderPlaced(i.orderId, i.customerInfo, i.shippingAddress, i.billingAddress, i.amountToBill, i.lines);

export const createBillingEvent: (i: PricedOrder) => O.Option<BillableOrderPlaced> =
  ({ orderId, billingAddress, amountToBill }) => amountToBill.value > 0
    ? O.some(new BillableOrderPlaced(orderId, billingAddress, amountToBill))
    : O.none;


/// helper to convert an Option into a List
export const optionToList: <T>(opt: O.Option<T>) => Array<T> = O.match(
  () => [],
  x => [x],
);

export const createEvents: CreateEvents = (pricedOrder, acknowledgmentEventOpt) => [
  // return all the events
  pipe(
    pricedOrder,
    createOrderPlacedEvent,
    e => new OrderPlaced(e.orderId, e.customerInfo, e.shippingAddress, e.billingAddress, e.amountToBill, e.lines),
  ),
  ...pipe(
    acknowledgmentEventOpt,
    O.map(e => new OrderAcknowledgmentSent(e.orderId, e.emailAddress)),
    optionToList,
  ),
  ...pipe(
    pricedOrder,
    createBillingEvent,
    O.map(e => new BillableOrderPlaced(e.orderId, e.billingAddress, e.amountToBill)),
    optionToList,
  ),
];

export const placeOrderEvents = (pricedOrder: PricedOrder): Effect.Effect<PlaceOrderEvent[], RemoteServiceError, AcknowledgmentEnv> =>
  Effect.map(
    acknowledgeOrder(pricedOrder),
    ackOpt => createEvents(pricedOrder, ackOpt),
  );
