import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** O front pode mandar o CPF com máscara; aqui só interessam os dígitos. */
const onlyDigits = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\D/g, '') : value;

export class ForgotPasswordDto {
  @ApiProperty({ example: '10647145448', description: 'CPF do cadastro' })
  @Transform(onlyDigits)
  @IsString()
  @Matches(/^\d{11}$/, { message: 'CPF deve conter 11 dígitos' })
  document: string;
}

export class VerifyResetCodeDto {
  @ApiProperty({ example: '10647145448', description: 'CPF do cadastro' })
  @Transform(onlyDigits)
  @IsString()
  @Matches(/^\d{11}$/, { message: 'CPF deve conter 11 dígitos' })
  document: string;

  @ApiProperty({
    example: '48210376',
    description: 'Código recebido por e-mail',
  })
  @Transform(onlyDigits)
  @IsString()
  @Matches(/^\d{8}$/, { message: 'O código tem 8 dígitos' })
  code: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    description: 'Ticket devolvido pela validação do código',
    example: 'a3f1...64 caracteres hexadecimais',
  })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/, { message: 'Ticket inválido' })
  ticket: string;

  @ApiProperty({ example: 'senha-nova-2026', description: 'Nova senha' })
  @IsString()
  // O NIST (SP 800-63B) recomenda exigir tamanho e não composição obrigatória
  // de maiúscula/símbolo — regra de composição empurra o usuário para senhas
  // previsíveis do tipo "Senha1!". O teto de 72 é o limite do bcrypt: o que
  // passa disso é silenciosamente ignorado no hash.
  @MinLength(8, { message: 'A senha precisa de pelo menos 8 caracteres' })
  @MaxLength(72, { message: 'A senha pode ter no máximo 72 caracteres' })
  password: string;
}
