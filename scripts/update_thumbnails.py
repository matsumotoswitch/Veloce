import sqlite3
import sys
import os
import io

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow library is not installed.")
    print("Please install it using: pip install Pillow")
    sys.exit(1)

def update_thumbnails(db_path):
    if not os.path.exists(db_path):
        print(f"Error: Database file not found at {db_path}")
        sys.exit(1)
        
    print(f"Connecting to database: {db_path}")
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get all records that have a path
    cursor.execute("SELECT hash_key, path FROM cache WHERE path IS NOT NULL AND path != ''")
    rows = cursor.fetchall()
    
    total = len(rows)
    print(f"Found {total} records in cache.")
    
    deleted_count = 0
    updated_count = 0
    skipped_count = 0
    
    for i, (hash_key, path) in enumerate(rows):
        # 画面に進捗を表示 (carriage return \r を使って同じ行を上書き)
        if i % 10 == 0 or i == total - 1:
            print(f"Progress: {i+1}/{total} ({(i+1)/total*100:.1f}%)", end='\r')
            
        # ファイルが存在しなければ行を削除
        if not os.path.exists(path):
            cursor.execute("DELETE FROM cache WHERE hash_key = ?", (hash_key,))
            deleted_count += 1
            continue
            
        # 存在したら384x384のサムネイルを作成して更新
        try:
            with Image.open(path) as img:
                # JPEG保存のためにRGBAやパレット画像をRGBに変換
                if img.mode in ('RGBA', 'P', 'LA'):
                    # 透過部分は白背景にする
                    background = Image.new('RGB', img.size, (255, 255, 255))
                    if img.mode in ('RGBA', 'LA'):
                        background.paste(img, mask=img.split()[-1])
                    else:
                        background.paste(img)
                    img = background
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
                
                # アスペクト比を維持しつつ最大384x384にリサイズ
                img.thumbnail((384, 384), Image.Resampling.LANCZOS)
                
                # JPEGバイト列としてメモリ上に保存
                out = io.BytesIO()
                img.save(out, format='JPEG', quality=80)
                thumb_bytes = out.getvalue()
                
            cursor.execute("UPDATE cache SET thumbnail = ? WHERE hash_key = ?", (thumb_bytes, hash_key))
            updated_count += 1
        except Exception as e:
            # 画像が壊れている等のエラー時はスキップ
            skipped_count += 1
            
    print("\n\nCompleted!")
    print(f"Updated (384px thumbnail): {updated_count}")
    print(f"Deleted (file missing)   : {deleted_count}")
    print(f"Skipped (errors)         : {skipped_count}")
    
    print("\nCommitting changes and vacuuming database to reclaim space...")
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    print("Done!")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python update_thumbnails.py <path_to_veloce_cache.db>")
        sys.exit(1)
    
    db_path_arg = sys.argv[1]
    update_thumbnails(db_path_arg)
