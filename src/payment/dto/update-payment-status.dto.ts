import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus, PaymentMethod } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

/**
 * O `paymentId` **não** está aqui de propósito.
 *
 * Ele já veio pelo caminho da rota, que é o que o `EventTenantGuard` leu para
 * decidir de qual igreja é a cobrança. Aceitá-lo também pelo corpo criava duas
 * fontes para a mesma coisa: bastava pôr no caminho um pagamento da própria
 * igreja e no corpo o de outra, e a baixa caía na de outra.
 *
 * Isso era fechado por uma linha no controller que sobrescrevia o campo. A
 * linha estava lá e funcionava — mas era uma linha que dava para esquecer no
 * próximo handler. Sem o campo, não há o que esquecer.
 */
export class UpdatePaymentStatusDto {
  @ApiProperty({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  @IsOptional()
  status?: PaymentStatus;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsOptional()
  method?: PaymentMethod;

  @ApiProperty({ type: 'string', format: 'binary', required: false })
  @IsOptional()
  receiptFile?: Express.Multer.File;

  @ApiProperty({ type: 'string', required: false })
  @IsOptional()
  discountsAppliedId?: string;
}
