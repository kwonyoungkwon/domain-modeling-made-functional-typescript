// ======================================================
// This file contains the JSON API interface to the PlaceOrder workflow
//
// 1) The HttpRequest is turned into a DTO, which is then turned into a Domain object
// 2) The main workflow function is called
// 3) The output is turned into a DTO which is turned into a HttpResponse
// ======================================================

import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { flow, pipe } from 'fp-ts/function';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Price } from '../common-types';
import { OrderFormDto, PlaceOrderErrorDto, placeOrderEventDtoFromDomain } from './dto';
import { ValidationError } from './public-types';
import {
  AddressVerificationService,
  HtmlString,
  OrderAcknowledgmentLetterService,
  OrderAcknowledgmentSenderService,
  ProductCatalogService,
  PricingService,
  Sent,
  createCheckedAddress,
} from './implementation.types';
import { placeOrder } from './implementation';

type JsonString = string;

namespace Json {
  // This function serialize a domain object into a json string
  export const serialize = JSON.stringify

  // This function deserialize a json string into a domain object
  export const deserialize = <T extends object>(cls: { prototype: T }) =>
    flow(
      JSON.parse,
      obj => Object.setPrototypeOf(obj, cls.prototype) as T,
    )
}

/// Very simplified version!
class HttpRequest {
  constructor(
    readonly action: string,
    readonly uri: string,
    readonly body: JsonString,
  ) { }
}

/// Very simplified version!
class HttpResponse {
  constructor(
    readonly httpStatusCode: number,
    readonly body: JsonString,
  ) { }
}

/// An API takes a HttpRequest as input and returns a async response
type PlaceOrderApi = (i: HttpRequest) => Promise<HttpResponse>;

const fromEither = <E, A>(either: E.Either<E, A>) =>
  either._tag === 'Left'
    ? Effect.fail(either.left)
    : Effect.succeed(either.right);

// =============================
// Implementation
// =============================

// setup dummy dependencies

export const ProductCatalogLive = Layer.succeed(ProductCatalogService, {
  check: () => Effect.succeed(true),
});

export const AddressVerificationLive = Layer.succeed(AddressVerificationService, {
  check: flow(createCheckedAddress, Effect.succeed),
});

export const PricingLive = Layer.succeed(PricingService, {
  getPrice: () => Effect.succeed(Price.unsafeCreate(1)),
});

export const OrderAcknowledgmentLetterLive = Layer.succeed(OrderAcknowledgmentLetterService, {
  create: () => Effect.succeed(new HtmlString('some text')),
});

export const OrderAcknowledgmentSenderLive = Layer.succeed(OrderAcknowledgmentSenderService, {
  send: () => Effect.succeed(Sent),
});

// -------------------------------
// workflow
// -------------------------------

export const placeOrderApi: PlaceOrderApi = (request: HttpRequest) => {
  const workflow = pipe(
    fromEither(
      E.tryCatch(
        () => pipe(request.body, Json.deserialize(OrderFormDto)),
        e => e as Error,
      ),
    ),
    Effect.map(orderForm => orderForm.toUnvalidatedOrder()),
    Effect.mapError(ValidationError.from),
    Effect.flatMap(placeOrder),
    Effect.match({
      onFailure: flow(
        PlaceOrderErrorDto.fromDomain,
        Json.serialize,
        json => new HttpResponse(401, json),
      ),
      onSuccess: flow(
        A.map(placeOrderEventDtoFromDomain),
        Json.serialize,
        json => new HttpResponse(200, json),
      ),
    }),
  );

  const liveEnvironment = Layer.mergeAll(
    ProductCatalogLive,
    AddressVerificationLive,
    PricingLive,
    OrderAcknowledgmentLetterLive,
    OrderAcknowledgmentSenderLive,
  );

  return Effect.runPromise(Effect.provide(workflow, liveEnvironment));
};
