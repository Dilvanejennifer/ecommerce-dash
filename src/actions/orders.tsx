"use server";

import db from "@/db/db";
import OrderHistoryEmail from "@/email/OrderHistory";
import {
  getDiscountedAmount,
  usableDiscountCodeWhere,
} from "@/lib/discountCodeHelpers";
import { Resend } from "resend";
import Stripe from "stripe";
import { z } from "zod";

const emailSchema = z.string().email();
const resend = new Resend(process.env.RESEND_API_KEY as string);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

export async function emailOrderHistory(
  prevState: unknown,
  formData: FormData
): Promise<{ message?: string; error?: string }> {
  const result = emailSchema.safeParse(formData.get("email"));

  if (result.success === false) {
    return { error: "Invalid email address" };
  }

  const user = await db.user.findUnique({
    where: { email: result.data },
    select: {
      email: true,
      orders: {
        select: {
          pricePaidInCents: true,
          id: true,
          createdAt: true,
          product: {
            select: {
              id: true,
              name: true,
              imagePath: true,
              description: true,
            },
          },
        },
      },
    },
  });

  if (user == null) {
    return {
      message:
        "Check your email to view your order history and download your products.",
    };
  }

  const orders = user.orders.map(async (order) => {
    return {
      ...order,
      downloadVerificationId: (
        await db.downloadVerification.create({
          data: {
            expiresAt: new Date(Date.now() + 24 * 1000 * 60 * 60),
            productId: order.product.id,
          },
        })
      ).id,
    };
  });

  const data = await resend.emails.send({
    from: `Support <${process.env.SENDER_EMAIL}>`,
    to: user.email,
    subject: "Order History",
    react: <OrderHistoryEmail orders={await Promise.all(orders)} />,
  });

  if (data.error) {
    return {
      error: "There was an error sending your email. Please try again.",
    };
  }

  return {
    message:
      "Check your email to view your order history and download your products.",
  };
}

export async function createPaymentIntent(
  email: string,
  productId: string,
  discountCodeId?: string
) {
  try {
    const product = await db.product.findUnique({ where: { id: productId } });
    if (!product) return { error: "Product not found" };

    const discountCode =
      discountCodeId == null
        ? null
        : await db.discountCode.findUnique({
            where: { id: discountCodeId, ...usableDiscountCodeWhere(product.id) },
          });

    if (discountCode == null && discountCodeId != null) {
      return { error: "Coupon has expired" };
    }

    // Create user if not exists
    const user = await db.user.upsert({
      where: { email },
      update: {},
      create: { email }, // Assuming email is the only field for user creation
    });

    // Create order
    const amount =
      discountCode == null
        ? product.priceInCents
        : getDiscountedAmount(discountCode, product.priceInCents);

    const newOrder = await db.order.create({
      data: {
        pricePaidInCents: amount,
        userId: user.id, // Use the user's id
        productId: productId,
        discountCodeId: discountCode?.id || null,
      },
    });

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "USD",
      metadata: {
        productId: product.id,
        discountCodeId: discountCode?.id || null,
      },
    });

    if (!paymentIntent.client_secret) {
      return { error: "Failed to create payment intent" };
    }

    return { clientSecret: paymentIntent.client_secret };
  } catch (error) {
    console.error("An unexpected error occurred:", error);
    return {
      error: "An unexpected error occurred. Please try again later.",
    };
  }
}
