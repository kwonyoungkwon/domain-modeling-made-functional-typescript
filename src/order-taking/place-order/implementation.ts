import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { flow } from 'fp-ts/function';
import * as Effect from 'effect/Effect';
import { pipe } from 'effect/Function';
import * as O from 'fp-ts/Option';
import { match, P } from 'ts-pattern';
import { placeOrderEvents } from './implementation.common';
import {
  AddressNotFound,
  AddressVerification,
  AddressValidationError,
  InvalidFormat,
  PlaceOrderEnv,
  PricingEnv,
  Pricing,
  PricingService,
  ProductCatalog,
  ProductCatalogService,
  AddressVerificationService,
  CheckedAddress,
  ValidatedOrder,
  ValidatedOrderLine,
  ValidationEnv,
} from './implementation.types';
import { PricedOrder, PricedOrderLine, PricingError, RemoteServiceError, ValidationError } from './public-types';
import {
  Address,
  BillingAmount,
  createOrderQuantity,
  createProductCode,
  CustomerInfo,
  EmailAddress,
  OrderId,
  OrderLineId,
  PersonalName,
  ProductCode,
  String50,
  ZipCode,
} from '../common-types';

import type {
  PlaceOrder,
  UnvalidatedAddress,
  UnvalidatedCustomerInfo,
  UnvalidatedOrder,
  UnvalidatedOrderLine,
} from './public-types';

const fromEither = <E, A>(either: E.Either<E, A>) =>
  either._tag === 'Left'
    ? Effect.fail(either.left)
    : Effect.succeed(either.right);

const toCustomerInfo = (
  unvalidatedCustomerInfo: UnvalidatedCustomerInfo,
): E.Either<ValidationError, CustomerInfo> => pipe(
  E.Do,
  E.bind('firstName', () =>
    pipe(unvalidatedCustomerInfo.firstName, String50.create, E.mapLeft(ValidationError.from)),
  ),
  E.bind('lastName', () =>
    pipe(unvalidatedCustomerInfo.lastName, String50.create, E.mapLeft(ValidationError.from)),
  ),
  E.bind('emailAddress', () =>
    pipe(unvalidatedCustomerInfo.emailAddress, EmailAddress.create, E.mapLeft(ValidationError.from)),
  ),
  E.let('name', ({ firstName, lastName }) => new PersonalName(firstName, lastName)),
  E.map(scope => new CustomerInfo(scope.name, scope.emailAddress)),
);

const optEthToEthOpt: <E, T>(i: O.Option<E.Either<E, T>>) => E.Either<E, O.Option<T>> = O.match(
  () => E.right(O.none),
  E.map(O.some),
);

const toAddress = (checkedAddress: CheckedAddress): E.Either<ValidationError, Address> => pipe(
  E.Do,
  E.bind('addressLine1', () =>
    pipe(checkedAddress.addressLine1, String50.create, E.mapLeft(ValidationError.from)),
  ),
  E.bind('addressLine2', () =>
    pipe(checkedAddress.addressLine2, O.map(flow(String50.create, E.mapLeft(ValidationError.from))), optEthToEthOpt),
  ),
  E.bind('addressLine3', () =>
    pipe(checkedAddress.addressLine3, O.map(flow(String50.create, E.mapLeft(ValidationError.from))), optEthToEthOpt),
  ),
  E.bind('addressLine4', () =>
    pipe(checkedAddress.addressLine4, O.map(flow(String50.create, E.mapLeft(ValidationError.from))), optEthToEthOpt),
  ),
  E.bind('city', () => pipe(checkedAddress.city, String50.create, E.mapLeft(ValidationError.from))),
  E.bind('zipCode', () => pipe(checkedAddress.zipCode, ZipCode.create, E.mapLeft(ValidationError.from))),
  E.map(scope => new Address(scope.addressLine1, scope.addressLine2, scope.addressLine3, scope.addressLine4, scope.city, scope.zipCode)),
);

const toOrderId: (orderId: string) => E.Either<ValidationError, OrderId> = flow(
  OrderId.create,
  E.mapLeft(ValidationError.from),
);

const toOrderLineId: (orderLineId: string) => E.Either<ValidationError, OrderLineId> = flow(
  OrderLineId.create,
  E.mapLeft(ValidationError.from),
);

const toOrderQuantity = (productCode: ProductCode) => flow(
  createOrderQuantity(productCode),
  E.mapLeft(ValidationError.from),
);

const mapAddressError = (addrError: AddressValidationError | RemoteServiceError) =>
  match(addrError)
    .with(P.instanceOf(AddressNotFound), () => new ValidationError('Address not found'))
    .with(P.instanceOf(InvalidFormat), () => new ValidationError('Address has bad format'))
    .with(P.instanceOf(RemoteServiceError), e => e)
    .exhaustive();

const toProductCode = (productCatalog: ProductCatalog) => (productCode: string) =>
  pipe(
    productCode,
    createProductCode,
    E.mapLeft(ValidationError.from),
    fromEither,
    Effect.flatMap(pc =>
      pipe(
        productCatalog.check(pc),
        Effect.flatMap(exists =>
          exists
            ? Effect.succeed(pc)
            : Effect.fail<ValidationError | RemoteServiceError>(new ValidationError(`Invalid: ${pc.value}`)),
        ),
      ),
    ),
  );

const validateOrderLine = (productCatalog: ProductCatalog) => ({
  orderLineId,
  productCode,
  quantity,
}: UnvalidatedOrderLine) =>
  Effect.gen(function* (_) {
    const validId = yield* _(fromEither(toOrderLineId(orderLineId)));
    const validCode = yield* _(toProductCode(productCatalog)(productCode));
    const validQuantity = yield* _(fromEither(toOrderQuantity(validCode)(quantity)));
    return new ValidatedOrderLine(validId, validCode, validQuantity);
  });

const validateOrder = ({
  orderId,
  customerInfo,
  lines,
  shippingAddress,
  billingAddress,
}: UnvalidatedOrder): Effect.Effect<ValidatedOrder, ValidationError | RemoteServiceError, ValidationEnv> =>
  Effect.gen(function* (_) {
    const productCatalog = yield* _(ProductCatalogService);
    const addressVerification = yield* _(AddressVerificationService);

    const validId = yield* _(fromEither(toOrderId(orderId)));
    const validInfo = yield* _(fromEither(toCustomerInfo(customerInfo)));
    const validLines = yield* _(
      Effect.forEach(
        lines,
        validateOrderLine(productCatalog),
        { concurrency: 1 },
      ),
    );

    const checkedShippingAddress = yield* _(
      addressVerification.check(shippingAddress)
        .pipe(Effect.mapError(mapAddressError)),
    );
    const validShipAdr = yield* _(fromEither(toAddress(checkedShippingAddress)));

    const checkedBillingAddress = yield* _(
      addressVerification.check(billingAddress)
        .pipe(Effect.mapError(mapAddressError)),
    );
    const validBillingAdr = yield* _(fromEither(toAddress(checkedBillingAddress)));

    return new ValidatedOrder(validId, validInfo, validShipAdr, validBillingAdr, validLines);
  });

const toPricedOrderLine = (pricing: Pricing) => ({
  orderLineId,
  productCode,
  quantity,
}: ValidatedOrderLine) =>
  Effect.gen(function* (_) {
    const price = yield* _(pricing.getPrice(productCode));
    const linePrice = yield* _(pipe(
      price.multiply(quantity.value),
      E.mapLeft(PricingError.from),
      fromEither,
    ));

    return new PricedOrderLine(orderLineId, productCode, quantity, linePrice);
  });

const priceOrder = ({
  lines,
  orderId,
  customerInfo,
  shippingAddress,
  billingAddress,
}: ValidatedOrder): Effect.Effect<PricedOrder, PricingError | RemoteServiceError, PricingEnv> =>
  Effect.gen(function* (_) {
    const pricing = yield* _(PricingService);

    const pricedLines = yield* _(
      Effect.forEach(
        lines,
        toPricedOrderLine(pricing),
        { concurrency: 1 },
      ),
    );

    const amountToBill = yield* _(pipe(
      pricedLines,
      A.map(l => l.linePrice),
      BillingAmount.sumPrices,
      E.mapLeft(PricingError.from),
      fromEither,
    ));

    return new PricedOrder(
      orderId,
      customerInfo,
      shippingAddress,
      billingAddress,
      amountToBill,
      pricedLines,
    );
  });

export const placeOrder: PlaceOrder = (unvalidatedOrder) =>
  Effect.gen(function* (_) {
    const validatedOrder = yield* _(validateOrder(unvalidatedOrder));
    const pricedOrder = yield* _(priceOrder(validatedOrder));
    const events = yield* _(placeOrderEvents(pricedOrder));
    return events;
  });
