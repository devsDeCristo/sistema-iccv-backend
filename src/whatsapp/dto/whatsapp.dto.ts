import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

export class PairingCodeDto {
  @ApiProperty({
    example: '5544999999999',
    description: 'Número de origem com DDI e DDD, só dígitos',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  )
  @IsString()
  @Matches(/^\d{12,15}$/, {
    message: 'Informe o número com DDI e DDD, por exemplo 5544999999999',
  })
  phoneNumber: string;
}
