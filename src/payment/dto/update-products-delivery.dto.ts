import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateProductsDeliveryDto {
  @ApiProperty({
    description:
      'true registra a entrega dos produtos desta compra; false desfaz o registro',
    example: true,
  })
  @IsBoolean()
  delivered: boolean;
}
