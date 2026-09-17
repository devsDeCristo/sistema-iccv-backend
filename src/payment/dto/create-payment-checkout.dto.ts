import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

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
}
