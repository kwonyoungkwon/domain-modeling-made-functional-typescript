import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import { Option } from 'fp-ts/Option';
import { PhantomBrand, Wrapper } from '../../libs/brand';
import { bound } from '../../libs/decorator';
import { Entity, ValueObject } from '../../libs/model-type';

import type {
  OrderAcknowledgmentSent,
  PlaceOrderEvent,
  PricedOrder,
  RemoteServiceError,
  UnvalidatedAddress,
  PricingError,
} from './public-types';
import type { Address, CustomerInfo, EmailAddress, OrderId, OrderLineId, OrderQuantity, Price, ProductCode } from '../common-types';

// ======================================================
// Section 1 : Define each step in the workflow using types
// ======================================================

// ---------------------------
// Validation step
// ---------------------------

// Product validation

export class InvalidFormat {
  constructor(readonly message: string) { }
}
export class AddressNotFound {
  constructor(readonly message: string) { }
}

// Address validation
export type AddressValidationError = InvalidFormat | AddressNotFound;

// Address validation
declare const checkedAddress: unique symbol;
export type CheckedAddress = PhantomBrand<UnvalidatedAddress, typeof checkedAddress>;
export const createCheckedAddress = (i: UnvalidatedAddress) => i as CheckedAddress;

// Legacy function types (for pure/legacy implementations)
export type CheckProductCodeExists = (i: ProductCode) => boolean;
export type GetProductPrice = (i: ProductCode) => Price;
export type CreateOrderAcknowledgmentLetter = (i: PricedOrder) => HtmlString;
export type SendOrderAcknowledgment = (i: OrderAcknowledgement) => SendResult;

export interface ProductCatalog {
  check(productCode: ProductCode): Effect.Effect<boolean, RemoteServiceError>;
}

export class ProductCatalogService extends Context.Tag('ProductCatalog')<ProductCatalogService, ProductCatalog>() { }

export interface AddressVerification {
  check(address: UnvalidatedAddress): Effect.Effect<CheckedAddress, AddressValidationError | RemoteServiceError>;
}

export class AddressVerificationService extends Context.Tag('AddressVerification')<AddressVerificationService, AddressVerification>() { }

// ---------------------------
// Validated Order
// ---------------------------

export class ValidatedOrderLine extends Entity<OrderLineId> {
  constructor(
    readonly orderLineId: OrderLineId,
    readonly productCode: ProductCode,
    readonly quantity: OrderQuantity,
  ) {
    super();
  }

  isSameClass<ValidatedOrderLine>(obj: unknown): obj is ValidatedOrderLine {
    return obj instanceof ValidatedOrderLine;
  }

  @bound
  get id(): OrderLineId {
    return this.orderLineId;
  }
}

export class ValidatedOrder extends Entity<OrderId> {
  constructor(
    readonly orderId: OrderId,
    readonly customerInfo: CustomerInfo,
    readonly shippingAddress: Address,
    readonly billingAddress: Address,
    readonly lines: readonly ValidatedOrderLine[],
  ) {
    super();
  }

  isSameClass<ValidatedOrder>(obj: unknown): obj is ValidatedOrder {
    return obj instanceof ValidatedOrder;
  }

  @bound
  get id(): OrderId {
    return this.orderId;
  }
}

// ---------------------------
// Pricing step
// ---------------------------

export interface Pricing {
  getPrice(productCode: ProductCode): Effect.Effect<Price, PricingError | RemoteServiceError>;
}

export class PricingService extends Context.Tag('Pricing')<PricingService, Pricing>() { }

// ---------------------------
// Send OrderAcknowledgment
// ---------------------------

declare const htmlString: unique symbol;
export class HtmlString implements Wrapper<string, typeof htmlString> {
  [htmlString]!: never;
  constructor(readonly value: string) { }
}

export class OrderAcknowledgement extends ValueObject {
  constructor(
    readonly emailAddress: EmailAddress,
    readonly letter: HtmlString,
  ) { super() }
}

export const Sent = 'Sent' as const;
export const NotSent = 'NotSent' as const;
type SendResult = typeof Sent | typeof NotSent;

export interface OrderAcknowledgmentLetter {
  create(order: PricedOrder): Effect.Effect<HtmlString>;
}

export class OrderAcknowledgmentLetterService extends Context.Tag('OrderAcknowledgmentLetter')<OrderAcknowledgmentLetterService, OrderAcknowledgmentLetter>() { }

export interface OrderAcknowledgmentSender {
  send(acknowledgment: OrderAcknowledgement): Effect.Effect<SendResult, RemoteServiceError>;
}

export class OrderAcknowledgmentSenderService extends Context.Tag('OrderAcknowledgmentSender')<OrderAcknowledgmentSenderService, OrderAcknowledgmentSender>() { }

export type AcknowledgeOrder =
  (i: PricedOrder) => Effect.Effect<Option<OrderAcknowledgmentSent>, RemoteServiceError, OrderAcknowledgmentLetterService | OrderAcknowledgmentSenderService>;

// ---------------------------
// Create events
// ---------------------------

export type CreateEvents = (
  i1: PricedOrder,
  i2: Option<OrderAcknowledgmentSent>, // input (event from previous step)
) => PlaceOrderEvent[]; // output

export type ValidationEnv =
  | ProductCatalogService
  | AddressVerificationService;

export type PricingEnv = PricingService;

export type AcknowledgmentEnv =
  | OrderAcknowledgmentLetterService
  | OrderAcknowledgmentSenderService;

export type PlaceOrderEnv =
  | ValidationEnv
  | PricingEnv
  | AcknowledgmentEnv;
