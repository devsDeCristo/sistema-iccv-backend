import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Liga ou desliga o módulo de cobrança de uma igreja.
 *
 * Campo obrigatório e sem padrão de propósito: um `PATCH` com corpo vazio
 * caindo num default desligaria a cobrança de uma igreja por engano, e essa é
 * exatamente a falha que ninguém percebe até um inscrito não conseguir pagar.
 */
export class SetPaymentModuleDto {
  @ApiProperty({
    description: 'true liga a cobrança online desta igreja, false desliga',
    example: true,
  })
  @IsBoolean()
  enabled: boolean;
}
