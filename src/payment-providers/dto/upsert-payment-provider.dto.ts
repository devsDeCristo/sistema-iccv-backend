import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentProviderMode } from '@prisma/client';
import { IsBoolean, IsEnum, IsObject, IsOptional } from 'class-validator';

export class UpsertPaymentProviderDto {
  @ApiPropertyOptional({
    enum: PaymentProviderMode,
    default: PaymentProviderMode.PRODUCTION,
    description:
      'Sandbox usa as chaves de teste da casa e não movimenta dinheiro de verdade.',
  })
  @IsOptional()
  @IsEnum(PaymentProviderMode)
  mode?: PaymentProviderMode;

  @ApiPropertyOptional({
    description: 'Liga a integração sem precisar torná-la a padrão.',
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Passa a ser a casa que recebe os novos checkouts desta igreja. As outras saem do padrão na mesma transação.',
  })
  @IsOptional()
  @IsBoolean()
  makeDefault?: boolean;

  /**
   * Os campos vêm soltos porque cada casa pede os seus. A validação não é
   * frouxa por isso: `PaymentProviderService` confere chave a chave contra o
   * descriptor do adapter e recusa qualquer nome que não esteja lá.
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { token: '····', baseUrl: '' },
    description:
      'Campos declarados pelo adapter da casa. Campo secreto enviado vazio mantém o valor já gravado.',
  })
  @IsObject()
  credentials: Record<string, unknown>;
}
