import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export class CreatePaymentCheckoutDto {
  @ApiProperty()
  @IsUUID()
  userId: string;

  @ApiProperty()
  @IsUUID()
  eventId: string;

  @ApiProperty({ type: [String] })
  @IsUUID('4', { each: true })
  roleRegistrationId: string[];

  /** Pagamentos sem ingresso (compras avulsas de produto), pelo id */
  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsUUID('4', { each: true })
  paymentIds?: string[];

  /** A forma escolhida, quando o gateway da igreja pede a escolha antes */
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;
}
export class payloadCreatePaymentCheckoutDto {
  @ApiProperty({
    type: [String],
    description: 'Ingressos a pagar, pela regra de inscrição',
  })
  @IsOptional()
  @IsUUID('4', { each: true })
  roleRegistrationId?: string[];

  @ApiProperty({
    type: [String],
    required: false,
    description:
      'Compras avulsas de produto, pelo id do pagamento. Vão no mesmo checkout dos ingressos informados.',
  })
  @IsOptional()
  @IsUUID('4', { each: true })
  paymentIds?: string[];

  @ApiProperty({
    enum: PaymentMethod,
    required: false,
    description:
      'A forma de pagamento escolhida pelo inscrito. Só tem efeito no gateway que pede a escolha antes de criar o checkout (hoje o PayPal: PIX ou CREDIT_CARD). Sem ela, nesse gateway, a resposta traz `choice` em vez de `link`.',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;
}
